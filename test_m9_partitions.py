"""Partition rotation (RFC 3.9): invariants, retention, per-partition throttling, cross-partition choice."""
from inputs import MIB
from model import Config, Part, Table, simulate
from selector import select_across

NO_MERGES = dict(max_bytes_at_max_space=0)


def run(config, until=None, max_events=None):
    table = Table(config)
    table.start()
    table.engine.run(until or float("inf"), max_events or float("inf"), after_event=table.check_invariants)
    return table


def test_invariants_with_rotation_late_inserts_and_retention():
    config = Config(insert_rate=20, insert_bytes_mean=MIB, partition_seconds=120, late_insert_fraction=0.1, retention_partitions=3)
    table = Table(config)
    table.start()
    most = 0

    def check():
        nonlocal most
        table.check_invariants()
        most = max(most, len(table.partitions))

    table.engine.run(max_events=2 * 10**5, after_event=check)
    assert len(table.dropped_partitions) >= 3 and table.merges_done > 0
    assert most <= 3  # pending drops wait only for their running merges
    late = sum(1 for p in table.history_parts if p.level == 0 and p.partition < int(p.created_at // 120))
    assert late > 0


def test_retention_keeps_the_number_of_parts_bounded():
    config = Config(insert_rate=20, insert_bytes_mean=MIB, partition_seconds=60, retention_partitions=2, **NO_MERGES)
    table = run(config, until=600)
    # no merges: a partition holds about 60 * 20 parts, and only the 2 newest are kept
    assert len(table.parts) < 2 * 60 * 20 * 1.2 and len(table.dropped_partitions) == 9  # the rotation at t = 600 drops partition 8
    assert table.dropped_bytes > 0


def test_throttling_counts_the_largest_partition_not_all_parts():
    # 40 inserts per partition, threshold 100: total parts grow far above it, but no partition reaches it
    config = Config(arrivals="closed", clients=1, think_time=0.05, partition_seconds=2.0, parts_to_delay_insert=100,
                    parts_to_throw_insert=200, **NO_MERGES)
    table = run(config, until=200)
    assert len(table.parts) > 1000 and table.delayed == 0 and table.rejected == 0


def test_max_parts_in_total_counts_all_partitions():
    config = Config(arrivals="closed", clients=1, think_time=0.05, partition_seconds=2.0, max_parts_in_total=500, **NO_MERGES)
    table = run(config, until=100)
    assert len(table.parts) == 500 and table.rejected > 0


def test_merges_stay_inside_partitions_and_ties_go_to_the_later_one():
    now = 1e6
    partitions = {k: [Part(10 * k + i, 10 * k + i, 10 * k + i, 0, 10 * MIB, now, partition=k) for i in range(5)] for k in (0, 1)}
    assert select_across(partitions, now, 150 * 1024 * MIB, Config(), "simple") == (1, 0, 5)
    assert select_across(partitions, now, 150 * 1024 * MIB, Config(), "simple_reference") == (1, 0, 5)
    assert select_across(partitions, now, 150 * 1024 * MIB, Config(), "tiered") == (0, 0, 5)


def test_one_partition_by_default():
    table = simulate(Config(), 600)
    assert list(table.partitions) == [0] and not table.dropped_partitions


if __name__ == "__main__":
    for name, test in list(globals().items()):
        if name.startswith("test_"):
            test()
            print("ok", name)
