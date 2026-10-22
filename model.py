from collections import deque
from dataclasses import KW_ONLY, dataclass
import itertools
import math

from engine import Engine
from inputs import MIB, burst_rate, daily_rate, lognormal, next_arrival, streams
from pool import Pool, Task
from selector import RESERVE_RATIO, SELECTORS, max_source_parts_bytes, select_across
from throttle import check_insert


@dataclass
class Config:
    arrivals: str = "open"  # or "closed"
    insert_rate: float = 2.0  # open: mean inserts per second
    rate_amplitude: float = 0.0  # open: a in rate * (1 + a * cos(...)) over a day
    rate_peak_at: float = 14 * 3600  # open: seconds since midnight
    burst: tuple = None  # open: (start, duration, factor), ignored unless factor > 1
    clients: int = 4  # closed
    think_time: float = 2.0  # closed: mean seconds from the end of an insert to the next one
    insert_bytes_mean: float = 10 * MIB
    insert_bytes_cv: float = 1.0
    parts_to_delay_insert: int = 1000
    max_delay_to_insert: int = 1  # seconds
    min_delay_to_insert_ms: int = 10
    max_avg_part_size_for_too_many_parts: int = 1024 * MIB
    max_parts_in_total: int = 100000
    threads: int = 16  # background_pool_size
    concurrency_ratio: int = 2  # background_merges_mutations_concurrency_ratio
    scheduling_policy: str = "round_robin"  # background_merges_mutations_scheduling_policy
    selector: str = "simple"  # or "tiered", the baseline
    base: float = 5.0  # merge_selector_base
    window_size: int = 1000  # merge_selector_window_size
    max_parts_to_merge_at_once: int = 100
    lower_max_parts_exponent: int = 5  # merge_selector_heuristic_to_lower_max_parts_to_merge_at_once_exponent
    parts_to_throw_insert: int = 3000
    max_bytes_at_max_space: int = 150 * 1024 * MIB  # max_bytes_to_merge_at_max_space_in_pool
    max_bytes_at_min_space: int = MIB  # max_bytes_to_merge_at_min_space_in_pool
    free_entries_to_lower_max_size: int = 8  # number_of_free_entries_in_pool_to_lower_max_size_of_merge
    # ponytail: uncalibrated defaults, calibrate.calibrated_config sets the measured ones
    merge_fixed_seconds: float = 0.05
    merge_bytes_per_second: float = 150e6
    merge_noise_cv: float = 0.3
    # projections and skip indices as (storage overhead, merge time overhead) pairs (RFC 3.7)
    aux: tuple = ()
    # merged part size ratios, large_merge_bytes 0 turns the large regime off (RFC 3.1)
    result_ratio: float = 1.0
    result_ratio_large: float = 1.0
    large_merge_bytes: int = 0
    large_merge_time_factor: float = 1.0  # large merges take this much longer (RFC 3.7)
    # a new partition every partition_seconds, 0 means one for the whole run (RFC 3.9)
    partition_seconds: float = 0.0
    late_insert_fraction: float = 0.0  # share of inserts whose data belongs to the previous partition
    retention_partitions: int = 0  # newest partitions to keep, current included, 0 keeps all
    # seconds from a trigger to the assignee run, 0 runs it at once
    assign_latency: float = 0.0
    # bytes the table may take, 0 means no limit (RFC 3.10)
    disk_bytes: int = 0
    old_parts_lifetime: float = 480.0
    seed: int = 1


@dataclass(eq=False)
class Part:
    id: int
    min_block: int
    max_block: int
    level: int
    size: int
    created_at: float
    _: KW_ONLY
    partition: int = 0
    blocks: int = 1  # inserts it holds
    fresh: int = 0  # bytes that never went through a large merge (RFC 3.1)
    merging: bool = False
    picked_at: float = None  # reset if DROP PARTITION cancels the merge
    removed_at: float = None  # merged away or dropped
    dropped: bool = False


class Table:
    def __init__(self, config):
        self.cfg = config
        self.engine = Engine()
        if config.arrivals not in ("open", "closed"):
            raise ValueError(f"unknown arrivals {config.arrivals}")
        self.rng = streams(config.seed, "arrival", "thinning", "size", "merge", "assignee", "partition",
                           "burst_arrival", "burst_thinning", "burst_size", "burst_partition")
        self.think = [streams(config.seed, f"think:{c}")[f"think:{c}"] for c in range(config.clients)]
        if not 0 <= config.rate_amplitude <= 1:
            raise ValueError("rate_amplitude must be in [0, 1], thinning needs 1 + a as the peak")
        self.rate, self.peak_rate = daily_rate(config.insert_rate, config.rate_amplitude, config.rate_peak_at)
        if config.burst and config.burst[2] > 1:
            self.burst_rate, self.burst_peak = burst_rate(self.rate, self.peak_rate, config.burst)
        self.aux_storage = 1 + sum(s for s, _ in config.aux)
        self.aux_time = 1 + sum(d for _, d in config.aux)
        if config.selector not in SELECTORS:
            raise ValueError(f"unknown selector {config.selector}")
        self.pool = Pool(self.engine, config.threads, config.threads * config.concurrency_ratio,
                         config.scheduling_policy, self.on_merge_done)
        self.partitions = {0: []}  # key -> active parts by block number, keys kept ascending
        self.partition_bytes = {0: 0}
        self.part_count = 0
        self.current_partition = 0
        self.dropped_partitions = []  # (key, dropped at)
        self._ids = itertools.count(1)
        self.last_block = 0
        self.inserted_bytes = 0
        self.dropped_bytes = 0
        self.dropped_blocks = 0
        self.saved_bytes = 0  # sources minus merged parts (RFC 3.1)
        self.trace = None  # set to a list to record events
        self.arrivals = 0
        self.in_flight = 0  # accepted inserts waiting out their delay
        self.rejected = 0
        self.rejected_disk = 0  # NOT_ENOUGH_SPACE at commit
        self.outdated = deque()  # (outdated at, bytes) still on disk, oldest first
        self.outdated_bytes = 0
        self.delayed = 0
        self.delay_total_ms = 0
        self.merged_bytes = 0
        self.merges_done = 0
        self.merges_aborted = 0
        self.selector_runs = 0
        # BackgroundJobsAssignee: one pending run at a time, backoff when idle
        self.no_work_count = 0
        self._assignee_at = math.inf
        self._assignee_token = 0
        self.history_parts = []
        self.history_merges = []  # (assigned_at, done_at, source bytes)
        self.history_aborted = []  # (assigned_at, cancelled_at, source bytes)
        self.history_inserts = []  # (arrival_at, delay_ms or None if rejected)
        self.history_nospace = []  # arrival times of inserts rejected with NOT_ENOUGH_SPACE

    @property
    def parts(self):
        return [p for parts in self.partitions.values() for p in parts]

    def start(self):
        if self.cfg.partition_seconds:
            self.engine.schedule(self.cfg.partition_seconds, self.on_partition_rotate, 1)
        if self.cfg.arrivals == "open":
            self._schedule_arrival()
            if self.cfg.burst and self.cfg.burst[2] > 1:
                self._schedule_burst_arrival(self.cfg.burst[0])
        else:
            for client in range(self.cfg.clients):
                self._think(client)
        self.trigger()

    def _schedule_arrival(self):
        at = next_arrival(self.engine.now, self.rate, self.peak_rate, self.rng["arrival"], self.rng["thinning"])
        self.engine.schedule(at - self.engine.now, self.on_insert_arrival, None)

    def _schedule_burst_arrival(self, after):
        start, duration, _ = self.cfg.burst
        at = next_arrival(max(after, start), self.burst_rate, self.burst_peak, self.rng["burst_arrival"],
                          self.rng["burst_thinning"], start + duration)
        if at is not None:
            self.engine.schedule(at - self.engine.now, self.on_insert_arrival, None, True)

    def _think(self, client):
        self.engine.schedule(self.think[client].expovariate(1 / self.cfg.think_time), self.on_insert_arrival, client)

    def on_insert_arrival(self, client, burst=False):
        """client is None for open arrivals"""
        if client is None:
            self._schedule_burst_arrival(self.engine.now) if burst else self._schedule_arrival()
        self.arrivals += 1
        # drawn before the throttling decision so the i-th insert is the same in every config
        stream = "burst_" if burst else ""
        size = max(1, round(lognormal(self.rng[stream + "size"], self.cfg.insert_bytes_mean, self.cfg.insert_bytes_cv) * self.aux_storage))
        target = self.current_partition
        if self.cfg.partition_seconds and self.cfg.late_insert_fraction:
            if self.rng[stream + "partition"].random() < self.cfg.late_insert_fraction and target > 0:
                target -= 1
        # getMaxPartsCountAndSizeForPartition: on a tie the first partition wins
        key = max(self.partitions, key=lambda k: len(self.partitions[k]))
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
        self.engine.schedule(delay_ms / 1000, self.on_insert_commit, size, client, target, self.engine.now)

    def on_insert_commit(self, size, client, key, arrived_at):
        self.in_flight -= 1
        # MergeTreeDataWriter reserves the in-memory block size, the model the part size (RFC 3.10)
        if self.cfg.disk_bytes and size > self.disk_free():
            self.rejected_disk += 1
            self.history_nospace.append(arrived_at)
            if self.trace is not None:
                self.trace.append(("nospace", self.engine.now, size))
            if client is not None:
                self._think(client)
            return
        self.last_block += 1
        if key not in self.partitions:
            # like clickhouse, data of a missing partition creates it, even one dropped before
            self.partition_bytes[key] = 0
            self.partitions = dict(sorted({**self.partitions, key: []}.items()))
        part = Part(next(self._ids), self.last_block, self.last_block, 0, size, self.engine.now, partition=key, fresh=size)
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

    def trigger(self):
        self.no_work_count //= 2
        if self._assignee_at > self.engine.now + self.cfg.assign_latency:
            self._schedule_assignee(self.cfg.assign_latency)

    def postpone(self):
        self.no_work_count += 1
        # the exponent cap only avoids OverflowError, the result is the same 600 s
        delay = min(600.0, 0.1 * 1.1 ** min(self.no_work_count, 200)) + self.rng["assignee"].uniform(0, 1)
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
        # clickhouse still selects on a full pool, skipping it only shifts the backoff (RFC 3.6)
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
        fresh = sum(p.fresh for p in sources)
        noise = lognormal(self.rng["merge"], 1.0, self.cfg.merge_noise_cv)
        work = self._merge_work(size, fresh) * noise
        result_size, result_fresh = self._merged_size(size, fresh)
        task = Task(next(self._ids), work, size, sources, result_size=result_size, result_fresh=result_fresh)
        self.pool.add(task)
        if self.trace is not None:
            self.trace.append(("assign", self.engine.now, task.id, key, begin, end - begin, work))
        return True

    def _merge_work(self, size, fresh):
        """thread-seconds before noise; a large-merged byte holds 1 / result_ratio_large times more data (RFC 3.7)"""
        cfg = self.cfg
        data = (fresh + (size - fresh) / cfg.result_ratio_large) / self.aux_storage
        work = (cfg.merge_fixed_seconds + data / cfg.merge_bytes_per_second) * self.aux_time
        if cfg.large_merge_bytes and size >= cfg.large_merge_bytes:
            work *= cfg.large_merge_time_factor
        return work

    def _merged_size(self, size, fresh):
        """empirical rule from system.part_log: a byte gets the large-merge ratio only once (RFC 3.1)"""
        cfg = self.cfg
        if cfg.large_merge_bytes and size >= cfg.large_merge_bytes:
            return max(1, round(cfg.result_ratio * (size - fresh) + cfg.result_ratio_large * fresh)), 0
        return max(1, round(cfg.result_ratio * size)), round(cfg.result_ratio * fresh)

    def on_merge_done(self, task):
        sources = task.payload
        key = sources[0].partition
        parts = self.partitions[key]
        begin = parts.index(sources[0])
        level = max(p.level for p in sources) + 1
        merged = Part(task.id, sources[0].min_block, sources[-1].max_block, level, task.result_size, self.engine.now,
                      partition=key, blocks=sum(p.blocks for p in sources), fresh=task.result_fresh)
        parts[begin : begin + len(sources)] = [merged]
        self.part_count -= len(sources) - 1
        self.partition_bytes[key] += task.result_size - task.priority
        self.saved_bytes += task.priority - task.result_size
        for part in sources:
            part.removed_at = self.engine.now
        self._remove_outdated()
        self.outdated.append((self.engine.now, task.priority))
        self.outdated_bytes += task.priority
        self.history_parts.append(merged)
        self.history_merges.append((task.created_at, self.engine.now, task.priority))
        self.merged_bytes += task.priority
        self.merges_done += 1
        self.no_work_count += 1  # MergePlainMergeTreeTask::onCompleted postpones, which keeps the pending run
        if self.trace is not None:
            self.trace.append(("merged", self.engine.now, task.id, level, task.result_size))

    def on_partition_rotate(self, number):
        # not now // partition_seconds, float time drifts off multiples of a fractional period
        self.current_partition = number
        self.engine.schedule(self.cfg.partition_seconds, self.on_partition_rotate, number + 1)
        if self.cfg.retention_partitions:
            for key in list(self.partitions):
                if key <= number - self.cfg.retention_partitions:
                    self._drop(key)

    def _drop(self, key):
        """DROP PARTITION: stopMergesAndWait cancels every merge of the table, not just this partition's"""
        self._cancel_merges()
        parts = self.partitions.pop(key)
        del self.partition_bytes[key]
        size = 0
        for part in parts:
            part.removed_at = self.engine.now
            part.dropped = True
            size += part.size
            self.dropped_blocks += part.blocks
        self.dropped_bytes += size
        self.part_count -= len(parts)
        self._remove_outdated()
        self.outdated.append((self.engine.now, size))
        self.outdated_bytes += size
        if not self.partitions:
            self.partitions[self.current_partition] = []
            self.partition_bytes[self.current_partition] = 0
        self.dropped_partitions.append((key, self.engine.now))
        if self.trace is not None:
            self.trace.append(("drop", self.engine.now, key))

    def _cancel_merges(self):
        tasks = self.pool.cancel_all()
        for task in tasks:
            for part in task.payload:
                part.merging = False
                part.picked_at = None
            self.history_aborted.append((task.created_at, self.engine.now, task.priority))
            self.merges_aborted += 1
            if self.trace is not None:
                self.trace.append(("cancel", self.engine.now, task.id))

    def _remove_outdated(self):
        """clearOldPartsFromFilesystem, but exactly at old_parts_lifetime instead of periodically"""
        while self.outdated and self.outdated[0][0] + self.cfg.old_parts_lifetime <= self.engine.now:
            self.outdated_bytes -= self.outdated.popleft()[1]

    def disk_used(self):
        self._remove_outdated()
        merging = 0.0
        for task in self.pool.tasks:
            # MergeTask shrinks the reservation to (1 - progress) of the initial one
            progress = min(1.0, max(0.0, 1.0 - self.pool.remaining_now(task) / task.work)) if task.work > 0 else 1.0
            merging += task.result_size * progress + task.priority * RESERVE_RATIO * (1 - progress)
        return self.inserted_bytes - self.dropped_bytes - self.saved_bytes + self.outdated_bytes + merging

    def disk_free(self):
        """getMaxUnreservedFreeSpace, for the table alone"""
        return max(0.0, self.cfg.disk_bytes - self.disk_used())


    def check_invariants(self):
        """RFC section 7"""
        parts = self.parts
        assert sum(p.size for p in parts) == self.inserted_bytes - self.dropped_bytes - self.saved_bytes
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
                assert 0 <= part.fresh <= part.size
                assert part.blocks <= part.max_block - part.min_block + 1
                if i:
                    assert partition[i - 1].max_block < part.min_block
        if not self.cfg.partition_seconds:
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

    import stats

    for selector in ("simple", "tiered"):
        started = time.time()
        t = simulate(Config(selector=selector), until=float(sys.argv[1]) if len(sys.argv) > 1 else 86400)
        print(f"{selector}: events {t.engine.events}, mean parts {stats.summary(t)['parts_mean']:.1f}, final parts {len(t.parts)}, "
              f"merges {t.merges_done}, write amplification {t.merged_bytes / t.inserted_bytes:.2f}, "
              f"selector runs {t.selector_runs}, wall {time.time() - started:.1f}s")
