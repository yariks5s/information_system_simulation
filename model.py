"""MergeTree background merges: state and event handlers (RFC sections 3 and 5)."""
from collections import deque
from dataclasses import KW_ONLY, dataclass
import itertools
import math

from engine import Engine
from inputs import MIB, daily_rate, lognormal, next_arrival, streams
from pool import Pool, Task
from selector import RESERVE_RATIO, SELECTORS, max_source_parts_bytes, select_across
from throttle import check_insert


@dataclass
class Config:
    # input (RFC 3.2, 3.8)
    arrivals: str = "open"  # or "closed"
    insert_rate: float = 2.0  # open: mean inserts per second
    rate_amplitude: float = 0.0  # open: daily profile rate * (1 + a * cos(...))
    rate_peak_at: float = 14 * 3600  # open: seconds since midnight
    burst: tuple = None  # open: (start, duration, factor)
    clients: int = 4  # closed
    think_time: float = 2.0  # closed: mean seconds between the end of an insert and the next one
    insert_bytes_mean: float = 10 * MIB
    insert_bytes_cv: float = 1.0
    # throttling (RFC 3.3)
    parts_to_delay_insert: int = 1000
    max_delay_to_insert: int = 1  # seconds
    min_delay_to_insert_ms: int = 10
    max_avg_part_size_for_too_many_parts: int = 1024 * MIB
    max_parts_in_total: int = 100000
    # pool
    threads: int = 16  # background_pool_size
    concurrency_ratio: int = 2  # background_merges_mutations_concurrency_ratio
    scheduling_policy: str = "round_robin"  # background_merges_mutations_scheduling_policy
    # selector
    selector: str = "simple"  # or "tiered", the baseline
    base: float = 5.0  # merge_selector_base
    window_size: int = 1000  # merge_selector_window_size
    max_parts_to_merge_at_once: int = 100
    lower_max_parts_exponent: int = 5  # merge_selector_heuristic_to_lower_max_parts_to_merge_at_once_exponent
    parts_to_throw_insert: int = 3000
    max_bytes_at_max_space: int = 150 * 1024 * MIB  # max_bytes_to_merge_at_max_space_in_pool
    max_bytes_at_min_space: int = MIB  # max_bytes_to_merge_at_min_space_in_pool
    free_entries_to_lower_max_size: int = 8  # number_of_free_entries_in_pool_to_lower_max_size_of_merge
    # merge cost; ponytail: placeholder until the system.part_log calibration in M5
    merge_fixed_seconds: float = 0.05
    merge_bytes_per_second: float = 150e6
    merge_noise_cv: float = 0.3
    # projections and skip indices (RFC 3.7): (storage overhead s, merge time overhead δ) relative to the base data
    aux: tuple = ()
    # partitions (RFC 3.9): a new partition every partition_seconds (0: one partition for the whole run)
    partition_seconds: float = 0.0
    late_insert_fraction: float = 0.0  # share of inserts that go to the previous partition
    retention_partitions: int = 0  # keep this many newest partitions, the current one included (0: keep all)
    # seconds between a trigger and the assignee run; 0 in ClickHouse terms means "as soon as a thread is free"
    assign_latency: float = 0.0
    # disk (RFC 3.10): bytes the table may take (0: no limit), and how long merged parts stay on disk
    disk_bytes: int = 0
    old_parts_lifetime: float = 480.0
    seed: int = 1


@dataclass(eq=False)
class Part:
    id: int
    min_block: int
    max_block: int
    level: int
    size: int  # bytes
    created_at: float
    _: KW_ONLY  # the rest by keyword: a positional flag once landed in the wrong field
    partition: int = 0
    blocks: int = 1  # inserts it holds
    merging: bool = False
    picked_at: float = None  # a merge took it
    removed_at: float = None  # that merge finished, or the partition was dropped
    dropped: bool = False


class Table:
    def __init__(self, config):
        self.cfg = config
        self.engine = Engine()
        if config.arrivals not in ("open", "closed"):
            raise ValueError(f"unknown arrivals {config.arrivals}")
        self.rng = streams(config.seed, "arrival", "thinning", "size", "merge", "assignee", "partition")
        self.think = [streams(config.seed, f"think:{c}")[f"think:{c}"] for c in range(config.clients)]
        self.rate, self.peak_rate = daily_rate(config.insert_rate, config.rate_amplitude, config.rate_peak_at, config.burst)
        self.aux_storage = 1 + sum(s for s, _ in config.aux)
        self.aux_time = 1 + sum(d for _, d in config.aux)
        if config.selector not in SELECTORS:
            raise ValueError(f"unknown selector {config.selector}")
        self.pool = Pool(self.engine, config.threads, config.threads * config.concurrency_ratio,
                         config.scheduling_policy, self.on_merge_done)
        self.partitions = {0: []}  # partition key -> its active parts ordered by block number, keys ascending
        self.partition_bytes = {0: 0}
        self.part_count = 0
        self.dropped_partitions = []  # (key, dropped at)
        self.pending_drops = set()  # partitions to drop once their merges finish
        self._ids = itertools.count(1)
        self.last_block = 0
        self.inserted_bytes = 0
        self.dropped_bytes = 0
        self.dropped_blocks = 0
        self.trace = None  # a list to record events into, see trace.py
        self.arrivals = 0
        self.in_flight = 0  # accepted inserts waiting out their delay
        self.rejected = 0
        self.rejected_disk = 0  # NOT_ENOUGH_SPACE at commit
        self.outdated = deque()  # (outdated at, bytes) of merge sources still on disk, oldest first
        self.outdated_bytes = 0
        self.delayed = 0
        self.delay_total_ms = 0
        self.merged_bytes = 0
        self.merges_done = 0
        self.selector_runs = 0
        # BackgroundJobsAssignee: one pending run at a time, exponential backoff when idle
        self.no_work_count = 0
        self._assignee_at = math.inf
        self._assignee_token = 0
        # time integral of the number of active parts
        self.parts_area = 0.0
        self._parts_changed_at = 0.0
        # raw facts for stats.py
        self.history_parts = []  # every part ever created
        self.history_merges = []  # (assigned_at, done_at, source bytes)
        self.history_inserts = []  # (arrival_at, delay_ms or None if rejected)
        self.history_nospace = []  # commit times of inserts rejected with NOT_ENOUGH_SPACE

    @property
    def parts(self):
        """All active parts, partition by partition."""
        return [p for parts in self.partitions.values() for p in parts]

    def start(self):
        if self.cfg.partition_seconds and self.cfg.retention_partitions:
            self.engine.schedule(self.cfg.partition_seconds, self.on_partition_rotate)
        if self.cfg.arrivals == "open":
            self._schedule_arrival()
        else:
            for client in range(self.cfg.clients):
                self._think(client)
        self.trigger()

    # inputs

    def _schedule_arrival(self):
        at = next_arrival(self.engine.now, self.rate, self.peak_rate, self.rng["arrival"], self.rng["thinning"])
        self.engine.schedule(at - self.engine.now, self.on_insert_arrival, None)

    def _think(self, client):
        self.engine.schedule(self.think[client].expovariate(1 / self.cfg.think_time), self.on_insert_arrival, client)

    def on_insert_arrival(self, client):
        """client is None in the open model."""
        if client is None:
            self._schedule_arrival()
        self.arrivals += 1
        # drawn before the throttling decision, so that the i-th insert has the same size in every configuration
        size = max(1, round(lognormal(self.rng["size"], self.cfg.insert_bytes_mean, self.cfg.insert_bytes_cv) * self.aux_storage))
        key = max(self.partitions, key=lambda k: (len(self.partitions[k]), k))
        delay_ms = check_insert(len(self.partitions[key]), self.partition_bytes[key], self.cfg, self.part_count)
        self.history_inserts.append((self.engine.now, delay_ms))
        if self.trace is not None:
            self.trace.append(("arrival", self.engine.now, delay_ms))
        if delay_ms is None:
            self.rejected += 1
            if client is not None:
                self._think(client)
            return
        if delay_ms:
            self.delayed += 1
            self.delay_total_ms += delay_ms
        self.in_flight += 1
        self.engine.schedule(delay_ms / 1000, self.on_insert_commit, size, client)

    def _partition_for_insert(self):
        if not self.cfg.partition_seconds:
            return 0
        key = int(self.engine.now // self.cfg.partition_seconds)
        if self.cfg.late_insert_fraction and self.rng["partition"].random() < self.cfg.late_insert_fraction:
            if key - 1 in self.partitions and key - 1 not in self.pending_drops:
                return key - 1
        return key

    def on_insert_commit(self, size, client):
        self.in_flight -= 1
        key = self._partition_for_insert()
        # MergeTreeDataWriter reserves space for the new part; the model reserves its size on disk (RFC 3.10)
        if self.cfg.disk_bytes and size > self.disk_free():
            self.rejected_disk += 1
            self.history_nospace.append(self.engine.now)
            if self.trace is not None:
                self.trace.append(("nospace", self.engine.now, size))
            if client is not None:
                self._think(client)
            return
        self.last_block += 1
        if key not in self.partitions:
            self.partitions[key] = []
            self.partition_bytes[key] = 0
        self._account_parts()
        part = Part(next(self._ids), self.last_block, self.last_block, 0, size, self.engine.now, partition=key)
        self.partitions[key].append(part)
        self.partition_bytes[key] += size
        self.part_count += 1
        self.history_parts.append(part)
        self.inserted_bytes += size
        if self.trace is not None:
            self.trace.append(("insert", self.engine.now, part.id, key, size, part.min_block))
        self.trigger()  # MergeTreeSink wakes the assignee after every insert
        if client is not None:
            self._think(client)

    # assignee

    def trigger(self):
        self.no_work_count //= 2
        if self._assignee_at > self.engine.now + self.cfg.assign_latency:
            self._schedule_assignee(self.cfg.assign_latency)

    def postpone(self):
        self.no_work_count += 1
        delay = min(600.0, 0.1 * 1.1**self.no_work_count) + self.rng["assignee"].uniform(0, 1)
        self._schedule_assignee(delay)

    def _schedule_assignee(self, delay):
        self._assignee_token += 1
        self._assignee_at = self.engine.now + delay
        self.engine.schedule(delay, self.on_assignee_run, self._assignee_token)

    def on_assignee_run(self, token):
        if token != self._assignee_token:
            return
        self._assignee_at = math.inf
        self.trigger() if self.try_assign_merge() else self.postpone()

    def try_assign_merge(self):
        # a full pool rejects the task, so the selection would be discarded anyway
        if not self.pool.has_capacity():
            return False
        self.selector_runs += 1
        free = self.disk_free() if self.cfg.disk_bytes else None
        max_bytes = max_source_parts_bytes(self.pool.max_tasks, len(self.pool.tasks), self.cfg, free)
        if max_bytes == 0:  # merges are disabled, or the disk is full
            return False
        found = select_across(self.partitions, self.engine.now, max_bytes, self.cfg, self.cfg.selector)
        if found is None:
            return False
        key, begin, end = found
        sources = self.partitions[key][begin:end]
        for part in sources:
            part.merging = True
            part.picked_at = self.engine.now
        size = sum(p.size for p in sources)
        noise = lognormal(self.rng["merge"], 1.0, self.cfg.merge_noise_cv)
        base_size = size / self.aux_storage
        work = (self.cfg.merge_fixed_seconds + base_size / self.cfg.merge_bytes_per_second) * noise * self.aux_time
        task = Task(next(self._ids), work, size, sources)
        self.pool.add(task)
        if self.trace is not None:
            self.trace.append(("assign", self.engine.now, task.id, key, begin, end - begin, work))
        return True

    # merges

    def on_merge_done(self, task):
        sources = task.payload
        key = sources[0].partition
        parts = self.partitions[key]
        begin = parts.index(sources[0])
        level = max(p.level for p in sources) + 1
        merged = Part(task.id, sources[0].min_block, sources[-1].max_block, level, task.priority, self.engine.now,
                      partition=key, blocks=sum(p.blocks for p in sources))
        self._account_parts()
        parts[begin : begin + len(sources)] = [merged]
        self.part_count -= len(sources) - 1
        for part in sources:
            part.removed_at = self.engine.now
        self._remove_outdated()
        self.outdated.append((self.engine.now, task.priority))
        self.outdated_bytes += task.priority
        self.history_parts.append(merged)
        self.history_merges.append((task.created_at, self.engine.now, task.priority))
        self.merged_bytes += task.priority
        self.merges_done += 1
        if self.trace is not None:
            self.trace.append(("merged", self.engine.now, task.id, level))
        if key in self.pending_drops:
            self._try_drop(key)

    # partitions

    def on_partition_rotate(self):
        self.engine.schedule(self.cfg.partition_seconds, self.on_partition_rotate)
        current = int(self.engine.now // self.cfg.partition_seconds)
        for key in list(self.partitions):
            if key <= current - self.cfg.retention_partitions:
                self.pending_drops.add(key)
                self._try_drop(key)

    def _try_drop(self, key):
        """DROP PARTITION, once no merge of this partition is running."""
        parts = self.partitions[key]
        if any(p.merging for p in parts):
            return
        self._account_parts()
        for part in parts:
            part.removed_at = self.engine.now
            part.dropped = True
            self.dropped_bytes += part.size
            self.dropped_blocks += part.blocks
        self.part_count -= len(parts)
        del self.partitions[key], self.partition_bytes[key]
        if not self.partitions:
            self.partitions[key + 1] = []
            self.partition_bytes[key + 1] = 0
        self.pending_drops.discard(key)
        self.dropped_partitions.append((key, self.engine.now))
        if self.trace is not None:
            self.trace.append(("drop", self.engine.now, key))

    # disk (RFC 3.10)

    def _remove_outdated(self):
        """clearOldPartsFromFilesystem: merge sources older than old_parts_lifetime leave the disk."""
        while self.outdated and self.outdated[0][0] + self.cfg.old_parts_lifetime <= self.engine.now:
            self.outdated_bytes -= self.outdated.popleft()[1]

    def disk_used(self):
        """Active parts, outdated parts not yet removed, and what running merges have written or reserved."""
        self._remove_outdated()
        merging = 0.0
        for task in self.pool.tasks:
            # MergeTask shrinks the reservation to (1 - progress) of the initial one as it writes the new part
            progress = min(1.0, max(0.0, 1.0 - self.pool.remaining_now(task) / task.work)) if task.work > 0 else 1.0
            merging += task.priority * (progress + (1 - progress) * RESERVE_RATIO)
        return self.inserted_bytes - self.dropped_bytes + self.outdated_bytes + merging

    def disk_free(self):
        """getMaxUnreservedFreeSpace for the table."""
        return max(0.0, self.cfg.disk_bytes - self.disk_used())

    def _account_parts(self):
        self.parts_area += self.part_count * (self.engine.now - self._parts_changed_at)
        self._parts_changed_at = self.engine.now

    def mean_parts(self):
        self._account_parts()
        return self.parts_area / self.engine.now if self.engine.now else 0.0

    def check_invariants(self):
        """RFC section 7."""
        parts = self.parts
        assert sum(p.size for p in parts) == self.inserted_bytes - self.dropped_bytes
        assert sum(p.blocks for p in parts) == self.last_block - self.dropped_blocks
        assert len(parts) == self.part_count
        assert self.arrivals == self.last_block + self.in_flight + self.rejected + self.rejected_disk
        if self.cfg.disk_bytes:
            assert self.disk_used() <= self.cfg.disk_bytes * (1 + 1e-9)
        assert list(self.partitions) == sorted(self.partitions)
        for key, partition in self.partitions.items():
            assert self.partition_bytes[key] == sum(p.size for p in partition)
            for i, part in enumerate(partition):
                assert part.partition == key and part.max_block >= part.min_block and not part.dropped
                assert part.blocks <= part.max_block - part.min_block + 1
                if i:
                    assert partition[i - 1].max_block < part.min_block
        if not self.cfg.partition_seconds:
            # one partition: the parts cover the blocks 1..last_block without gaps
            expected = 1
            for part in parts:
                assert part.min_block == expected
                expected = part.max_block + 1
            assert expected == self.last_block + 1
        assert len(self.pool.tasks) <= self.pool.max_tasks
        assert self.pool.busy_threads() <= self.pool.threads + 1e-9
        for task in self.pool.tasks:
            partition = self.partitions[task.payload[0].partition]
            first = partition.index(task.payload[0])
            assert all(p.merging and partition[first + j] is p for j, p in enumerate(task.payload))
        assert sum(len(t.payload) for t in self.pool.tasks) == sum(p.merging for p in parts)


def simulate(config, until, check=False):
    table = Table(config)
    table.start()
    table.engine.run(until, after_event=table.check_invariants if check else None)
    return table


if __name__ == "__main__":
    import sys
    import time

    for selector in ("simple", "tiered"):
        started = time.time()
        t = simulate(Config(selector=selector), until=float(sys.argv[1]) if len(sys.argv) > 1 else 86400)
        print(f"{selector}: events {t.engine.events}, mean parts {t.mean_parts():.1f}, final parts {len(t.parts)}, "
              f"merges {t.merges_done}, write amplification {t.merged_bytes / t.inserted_bytes:.2f}, "
              f"selector runs {t.selector_runs}, wall {time.time() - started:.1f}s")
