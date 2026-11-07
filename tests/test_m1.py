"""M1 acceptance, see RFC section 10"""
import math

from model import Config, Table, simulate


def run_events(config, events):
    table = Table(config)
    table.start()
    table.engine.run(max_events=events, after_event=table.check_invariants)
    return table


def test_invariants_million_events():
    table = run_events(Config(selector="tiered"), 10**6)
    assert table.engine.events == 10**6 and table.merges_done > 0


def test_invariants_overloaded():
    table = run_events(Config(selector="tiered", threads=1, merge_bytes_per_second=5e6), 10**4)
    assert len(table.parts) > 100


def test_reproducible():
    a, b = simulate(Config(seed=7), 3600), simulate(Config(seed=7), 3600)
    assert [p.size for p in a.parts] == [p.size for p in b.parts]


def test_merge_speed_does_not_shift_insert_stream():
    fast = simulate(Config(merge_bytes_per_second=1e9), 3600)
    slow = simulate(Config(merge_bytes_per_second=1e7), 3600)
    assert (fast.last_block, fast.inserted_bytes) == (slow.last_block, slow.inserted_bytes)
    assert not math.isclose(fast.merged_bytes, slow.merged_bytes)


if __name__ == "__main__":
    for name, test in list(globals().items()):
        if name.startswith("test_"):
            test()
            print("ok", name)
