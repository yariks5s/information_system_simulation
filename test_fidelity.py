"""Fixes from the review of 2026-10-11: merged part size and cost, DROP PARTITION, the assignee counter,
common random numbers for bursts and late inserts, and details of SimpleMergeSelector and throttling."""
import math

import numpy as np

from inputs import MIB
from model import Config, Part, Table
from pool import Task
from selector import _max_parts_to_merge, select_simple, select_tiered
from stats import summary, warmup_end, warmup_index, welch
from throttle import check_insert

SHRINK = dict(result_ratio=0.99, result_ratio_large=0.8, large_merge_bytes=100 * MIB, large_merge_time_factor=1.1)


def run(config, until):
    table = Table(config)
    table.start()
    table.engine.run(until, after_event=table.check_invariants)
    return table


def test_merged_size_shrinks_fresh_bytes_once():
    table = Table(Config(**SHRINK))
    assert table._merged_size(10 * MIB, 10 * MIB) == (round(0.99 * 10 * MIB), round(0.99 * 10 * MIB))
    assert table._merged_size(150 * MIB, 150 * MIB) == (round(0.8 * 150 * MIB), 0)
    # 120 MiB already went through a large merge, 30 MiB did not
    assert table._merged_size(150 * MIB, 30 * MIB) == (round(0.99 * 120 * MIB + 0.8 * 30 * MIB), 0)


def test_merge_work_counts_data_not_bytes():
    cfg = Config(**SHRINK, merge_fixed_seconds=0.0, merge_bytes_per_second=MIB)
    table = Table(cfg)
    assert math.isclose(table._merge_work(10 * MIB, 10 * MIB), 10)
    assert math.isclose(table._merge_work(150 * MIB, 150 * MIB), 150 * 1.1)
    # a compacted byte holds 1 / 0.8 times more data
    assert math.isclose(table._merge_work(200 * MIB, 0), 200 / 0.8 * 1.1)


def test_byte_balance_with_shrink():
    table = run(Config(insert_rate=50, insert_bytes_mean=4 * MIB, **SHRINK), until=400)
    assert table.saved_bytes > 0 and any(p.size >= 100 * MIB for p in table.parts)
    assert sum(p.size for p in table.parts) == table.inserted_bytes - table.saved_bytes


def test_drop_partition_cancels_every_merge_and_keeps_the_parts_on_disk():
    config = Config(insert_rate=40, insert_bytes_mean=4 * MIB, threads=1, merge_bytes_per_second=50e6,
                    partition_seconds=60, retention_partitions=2, old_parts_lifetime=100)
    table = Table(config)
    table.start()
    table.engine.run(119.999)
    running = len(table.pool.tasks)
    table.engine.run(120.0)  # the rotation at 120 s drops partition 0
    assert table.dropped_partitions[0][0] == 0 and running > 0 and table.merges_aborted == running
    assert not table.pool.tasks and not any(p.merging for p in table.parts)  # the assignee sleeps after the DROP
    table.check_invariants()
    dropped = sum(p.size for p in table.history_parts if p.dropped)
    assert table.outdated_bytes >= dropped > 0  # outdated for old_parts_lifetime, like merge sources
    table.engine.run(200)
    table.check_invariants()
    assert summary(table)["merges_aborted"] == table.merges_aborted


def five_parts(table):
    table.partitions[0] = [Part(i, i + 1, i + 1, 0, MIB, 0.0, fresh=MIB) for i in range(5)]
    table.partition_bytes[0], table.part_count = 5 * MIB, 5


def test_assignee_counter_grows_after_merges():
    # not started: no inserts and no assignee runs, only the merge below
    table = Table(Config())
    five_parts(table)
    table.no_work_count = 4
    assert table.try_assign_merge()
    table.engine.run()
    assert table.merges_done == 1 and table.no_work_count == 5
    # a full pool skips the selection and postpones once
    full = Table(Config(threads=1, concurrency_ratio=1))
    full.pool.add(Task(0, 1e9, 0, []))
    five_parts(full)
    full.on_assignee_run(full._assignee_token)
    assert full.no_work_count == 1 and full.selector_runs == 0


def test_burst_adds_arrivals_without_moving_the_base_ones():
    def arrivals(burst):
        table = run(Config(insert_rate=20, insert_bytes_mean=MIB, burst=burst), until=300)
        return [t for t, _ in table.history_inserts], [p.size for p in table.history_parts if p.level == 0]

    base, base_sizes = arrivals(None)
    burst, burst_sizes = arrivals((100.0, 50.0, 3.0))
    assert set(base) < set(burst)
    assert [t for t in base if t < 100] == [t for t in burst if t < 100]
    extra = len(burst) - len(base)
    assert 0.7 < extra / (2 * 20 * 50) < 1.3
    assert set(base_sizes) < set(burst_sizes)


def test_late_inserts_are_decided_at_arrival():
    def partitions(speed):
        cfg = Config(insert_rate=20, insert_bytes_mean=MIB, partition_seconds=30, late_insert_fraction=0.3, merge_bytes_per_second=speed)
        table = run(cfg, until=200)
        return [p.partition for p in sorted((p for p in table.history_parts if p.level == 0), key=lambda p: p.min_block)]

    assert partitions(150e6) == partitions(20e6)


def test_whole_second_ages():
    import selector

    size = 10 * MIB  # two such parts pass the condition exactly when the base is lowered to 2, at the age `limit`
    norm = selector._unit(math.log(1 + 2 * size), selector.MIN_SIZE_TO_LOWER_BASE_LOG, selector.MAX_SIZE_TO_LOWER_BASE_LOG)
    limit = selector._lerp(selector.AGE_TO_LOWER_BASE_AT_MIN_SIZE[1], selector.AGE_TO_LOWER_BASE_AT_MAX_SIZE[1], norm)
    whole = math.ceil(limit)
    now = 10.0**7
    created = now - whole + (whole - limit + 1) / 2  # a float age just under the limit, whole seconds at it
    assert now - created < limit <= math.floor(now) - math.floor(created)
    ps = [Part(i, i + 1, i + 1, 0, size, created) for i in range(2)]
    assert select_simple(ps, now, 10**12, Config()) == (0, 2)


def test_max_parts_limit_details():
    cfg = Config(max_parts_to_merge_at_once=3)
    assert _max_parts_to_merge(3000, cfg) == 3  # the min applies in every branch
    unlimited = Config(max_parts_to_merge_at_once=0)
    ps = [Part(i, i + 1, i + 1, 0, 10 * MIB, 0.0) for i in range(10)]
    assert select_simple(ps, 1e7, 10**12, unlimited) == (0, 10)  # 0 means no limit


def test_tiered_merges_at_least_two_parts():
    ps = [Part(i, i + 1, i + 1, 0, MIB, 0.0) for i in range(3)]
    begin, end = select_tiered(ps, 1e7, 10**12, Config(selector="tiered", base=1.5))
    assert end - begin == 2


def test_delay_rounds_like_clickhouse():
    cfg = Config(max_delay_to_insert=2, parts_to_delay_insert=1000, parts_to_throw_insert=3000)
    small = MIB
    # static_cast<UInt64>(max_ms * (over / allowed)): 2000 * (1001 / 2000) = 1000.9999..., not 1001
    assert check_insert(2000, 2000 * small, cfg) == int(2000 * (1001 / 2000))


def test_welch_does_not_judge_by_the_unsmoothed_end():
    curve = np.full(121, 10.0)
    curve[-1] = 12.0
    smoothed = welch([curve], window=5)
    assert len(smoothed) == 116 and warmup_index(smoothed) == 0


def test_welch_band_covers_the_noise_of_the_curve():
    rng = np.random.default_rng(1)
    noisy = 10 + rng.normal(0, 1.5, 121)  # stationary from the start, but noisy: a 5% band would read noise as a trend
    assert warmup_end(noisy) <= 6
    rising = np.concatenate([np.linspace(0, 20, 40), np.full(81, 20.0)]) + rng.normal(0, 0.5, 121)
    assert 30 <= warmup_end(rising) <= 45


def test_postpone_does_not_overflow():
    table = Table(Config(insert_rate=1e-9))
    table.start()
    table.no_work_count = 10**4
    table.postpone()
    assert table._assignee_at <= table.engine.now + 601
