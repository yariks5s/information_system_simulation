"""The vectorized selector chooses exactly what the reference implementation chooses."""
import math
import random

from inputs import MIB, lognormal
from model import Config, Part, simulate
from selector import _max_parts_to_merge, _segment_best, _segment_best_fast, _segments, select_simple, select_simple_fast


def random_case(rng):
    n = rng.choice([2, 3, 5, 8, 20, 60, 150, 400])
    now = 1e7
    equal = rng.random() < 0.3  # equal sizes produce score ties
    size = rng.choice([0.1, 1, 10, 1000]) * MIB
    cv = rng.choice([0.0, 0.5, 1.0, 3.0])
    parts = []
    for i in range(n):
        s = size if equal else lognormal(rng, size, cv)
        age = rng.choice([0.0, 5.0, rng.uniform(0, 3600), rng.uniform(0, 5e6)])
        parts.append(Part(i, i + 1, i + 1, 0, max(1, round(s)), now - age, merging=rng.random() < 0.05))
    cfg = Config(base=rng.choice([2.0, 5.0, 10.0]), window_size=rng.choice([1000, 50, 7]),
                 max_parts_to_merge_at_once=rng.choice([100, 10, 3]))
    max_bytes = rng.choice([150 * 1024 * MIB, 64 * MIB, 5 * size])
    return parts, now, max_bytes, cfg


def test_random_cases_agree():
    rng = random.Random(42)
    for case in range(3000):
        parts, now, max_bytes, cfg = random_case(rng)
        assert select_simple_fast(parts, now, max_bytes, cfg) == select_simple(parts, now, max_bytes, cfg), case
        # the numpy path itself, also on segments too short for the hybrid to pick it
        max_parts = _max_parts_to_merge(len(parts), cfg)
        for offset, segment in _segments(parts):
            if len(segment) > 1:
                expected = _segment_best(segment, offset, now, max_bytes, max_parts, cfg)
                actual = _segment_best_fast(segment, offset, now, max_bytes, max_parts, cfg)
                # numpy log2 may differ from math.log2 in the last bit of the score
                assert (actual is None) == (expected is None), case
                if actual is not None:
                    assert actual[2:] == expected[2:] and math.isclose(actual[0], expected[0], rel_tol=1e-12), case


def test_trajectories_agree():
    # whole simulations must match event by event, including near the stability boundary
    for config in (Config(), Config(threads=2, insert_rate=60, insert_bytes_mean=MIB)):
        until = 3600 if config.threads == 16 else 600
        fast = simulate(config, until)
        reference = simulate(Config(**{**config.__dict__, "selector": "simple_reference"}), until)
        assert fast.merges_done == reference.merges_done
        assert [(p.min_block, p.max_block) for p in fast.parts] == [(p.min_block, p.max_block) for p in reference.parts]


if __name__ == "__main__":
    for name, test in list(globals().items()):
        if name.startswith("test_"):
            test()
            print("ok", name)
