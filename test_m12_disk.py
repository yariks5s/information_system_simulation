from inputs import MIB
from model import Config, Table
from selector import max_source_parts_bytes


def run(config, until):
    table = Table(config)
    table.start()
    table.engine.run(until, after_event=table.check_invariants)
    return table


def test_free_space_caps_the_merge_size():
    cfg = Config()
    assert max_source_parts_bytes(32, 0, cfg) == cfg.max_bytes_at_max_space
    assert max_source_parts_bytes(32, 0, cfg, free_disk=10 * MIB) == 5 * MIB
    assert max_source_parts_bytes(32, 0, cfg, free_disk=1.0) == 0
    # 31 of 32 slots busy, so the pool limit is the smaller one
    assert max_source_parts_bytes(32, 31, cfg, free_disk=10**15) == max_source_parts_bytes(32, 31, cfg)


def test_a_full_disk_rejects_inserts_and_bounds_merges():
    disk = 2000 * MIB
    table = run(Config(insert_rate=50, insert_bytes_mean=MIB, disk_bytes=disk, old_parts_lifetime=30), until=300)
    # the disk fills in about 40 s
    assert table.rejected_disk > 0 and table.merges_done > 0
    assert table.inserted_bytes - table.dropped_bytes <= disk
    assert max(size for *_, size in table.history_merges) <= disk / 2


def test_outdated_parts_stay_for_their_lifetime():
    table = run(Config(insert_rate=20, insert_bytes_mean=MIB, old_parts_lifetime=60), until=400)
    table.disk_used()  # removes outdated parts past their lifetime
    now = table.engine.now
    expected = sum(p.size for p in table.history_parts if p.removed_at is not None and not p.dropped and p.removed_at + 60 > now)
    assert table.outdated_bytes == expected > 0
    assert table.disk_used() >= table.inserted_bytes + expected


def test_a_shorter_lifetime_frees_space_for_larger_merges():
    def largest_merge(lifetime):
        table = run(Config(insert_rate=50, insert_bytes_mean=MIB, disk_bytes=6000 * MIB, old_parts_lifetime=lifetime), until=150)
        return table, max(size for *_, size in table.history_merges)

    short, short_largest = largest_merge(5)
    long, long_largest = largest_merge(480)
    assert short_largest > long_largest and short.rejected_disk <= long.rejected_disk
