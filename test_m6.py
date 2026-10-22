"""M6 acceptance, see RFC section 10"""
import math

import numpy as np
from scipy import stats as sps

import stats
from inputs import MIB
from model import Config, simulate



def test_step_stats_by_hand():
    # 0 on [0, 1), 1 on [1, 2), 2 on [2, 4), 0 on [4, 5]
    mean, distribution = stats.step_stats([(1, 1), (2, 1), (4, -2)], 0, 5)
    assert math.isclose(mean, 1.0) and distribution == {0: 0.4, 1: 0.2, 2: 0.4}
    mean, _ = stats.step_stats([(1, 1), (2, 1), (4, -2)], 1.5, 3)  # 1 for 0.5 s, 2 for 1 s
    assert math.isclose(mean, 2.5 / 1.5)


def test_time_integral_equals_sum_of_lifetimes():
    table = simulate(Config(), 3 * 3600)
    lifetimes = sum((p.removed_at if p.removed_at is not None else table.engine.now) - p.created_at for p in table.history_parts)
    mean, _ = stats.step_stats(stats.parts_changes(table), 0, table.engine.now)
    assert math.isclose(mean * table.engine.now, lifetimes, rel_tol=1e-9)


def test_little_law_for_fresh_parts():
    for config in (Config(), Config(threads=2, insert_rate=40, insert_bytes_mean=MIB)):
        summary = stats.summary(simulate(config, 2 * 3600), warmup=1800)
        assert summary["little_relative_error"] < 0.05


def test_counters_match_the_model():
    table = simulate(Config(arrivals="closed", clients=2, think_time=0.1, parts_to_delay_insert=100,
                            parts_to_throw_insert=300, max_bytes_at_max_space=0), 300)
    summary = stats.summary(table)
    assert math.isclose(summary["rejected_fraction"], table.rejected / table.arrivals)
    assert math.isclose(summary["delayed_fraction"], table.delayed / table.arrivals)
    assert math.isclose(summary["delay_mean_ms"] * (table.arrivals - table.rejected), table.delay_total_ms)


def test_confidence_interval():
    values = [1.0, 2.0, 3.0, 4.0]
    mean, half = stats.confidence_interval(values)
    assert mean == 2.5 and math.isclose(half, sps.t.ppf(0.975, 3) * np.std(values, ddof=1) / 2)


def test_replications_are_reproducible_and_parallel_safe():
    config = Config(insert_rate=5)
    serial, _ = stats.replicate(config, 1800, 600, seeds=range(3), workers=1)
    parallel, _ = stats.replicate(config, 1800, 600, seeds=range(3), workers=3)
    assert serial == parallel
    assert len({s["parts_mean"] for s in serial}) == 3


def test_common_random_numbers_pair_exactly():
    # merge speed changes the parts but must not touch the arrival stream of the same seed
    a, _ = stats.replicate(Config(insert_rate=5), 1800, 600, seeds=range(3), workers=3)
    b, _ = stats.replicate(Config(insert_rate=5, merge_bytes_per_second=30e6), 1800, 600, seeds=range(3), workers=3)
    other, _ = stats.replicate(Config(insert_rate=5), 1800, 600, seeds=range(3, 6), workers=3)
    assert any(x["parts_mean"] != y["parts_mean"] for x, y in zip(a, b))
    assert stats.paired_difference(a, b, key=lambda s: s["insert_rate"]) == (0.0, 0.0)
    assert stats.paired_difference(a, other, key=lambda s: s["insert_rate"])[0] != 0.0


def test_welch_warmup():
    # a ramp that settles at 10 after index 30
    curves = [np.minimum(np.arange(100) / 3, 10) + noise for noise in np.random.default_rng(1).normal(0, 0.1, (5, 100))]
    smoothed = stats.welch(curves, window=3)
    assert 25 <= stats.warmup_index(smoothed) <= 35

