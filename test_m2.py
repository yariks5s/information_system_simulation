"""M2 acceptance, see RFC section 10"""
import math

from inputs import MIB
from model import Config, Part, Table, simulate
from selector import _max_parts_to_merge, _score, max_source_parts_bytes, select_simple

CFG = Config()
LIMIT = CFG.max_bytes_at_max_space


def parts(*sizes_mib, age=0.0, merging=()):
    now = 1e8
    return now, [Part(i, i + 1, i + 1, 0, round(s * MIB), now - age, merging=i in merging) for i, s in enumerate(sizes_mib)]


def select(sizes, max_bytes=LIMIT, **kwargs):
    now, ps = parts(*sizes, **kwargs)
    return select_simple(ps, now, max_bytes, CFG)


def test_fresh_equal_parts_need_base_of_them():
    # for equal parts (sum + n * fixed_cost) / (max + fixed_cost) is just n
    assert select([10] * 4) is None
    assert select([10] * 5) == (0, 5)
    assert select([10] * 6) == (0, 6)  # scores better than both 5-part ranges


def test_old_parts_lower_base_to_two():
    assert select([10, 10]) is None
    assert select([10, 10], age=1e7) == (0, 2)


def test_many_parts_lower_base_and_prefer_long_ranges():
    assert select([10] * 60) == (0, 60)


def test_merging_part_splits_ranges():
    assert select([10] * 8, merging={2}) == (3, 8)


def test_size_limit():
    now, ps = parts(*[10] * 5)
    assert select_simple(ps, now, 45 * MIB, CFG) is None


def test_small_part_at_right_is_dropped():
    # without the heuristic [0, 4) would win with score 152.6 MiB
    assert select([100, 100, 100, 0.5], age=1e7) == (0, 3)


def test_align_with_left_neighbour():
    _, ps = parts(40, 10, 10, 10, 10)
    score, end = _score(ps, 1, 5, 40 * MIB)
    assert end == 5 and math.isclose(score, (40 + 20) * MIB / 2.1 * 0.75)


def test_max_parts_heuristic():
    assert _max_parts_to_merge(4, CFG) == 100
    assert _max_parts_to_merge(60, CFG) == 99  # 99.9999998 truncates to 99
    assert _max_parts_to_merge(3000, CFG) == 5


def test_merge_size_limit_shrinks_with_busy_pool():
    assert max_source_parts_bytes(32, 1, CFG) == LIMIT
    assert max_source_parts_bytes(32, 24, CFG) == LIMIT  # 8 free entries still get the full limit
    assert max_source_parts_bytes(32, 28, CFG) == int(MIB * (LIMIT / MIB) ** 0.5)
    assert max_source_parts_bytes(32, 32, CFG) == MIB


def test_assignee_backs_off_when_idle():
    # backoff 0.1 * 1.1^n + U(0, 1) capped at 600 s gives about 247 runs in 1e5 s
    table = simulate(Config(insert_rate=1e-9), 1e5)
    assert 200 < table.selector_runs < 300


def test_invariants_with_simple_selector():
    table = Table(Config())
    table.start()
    table.engine.run(max_events=3 * 10**5, after_event=table.check_invariants)
    assert table.merges_done > 0 and table.mean_parts() < 100


if __name__ == "__main__":
    for name, test in list(globals().items()):
        if name.startswith("test_"):
            test()
            print("ok", name)
