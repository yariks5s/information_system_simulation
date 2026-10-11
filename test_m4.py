"""M4 acceptance (RFC section 10): throttling, rejection, closed clients and λ(t)."""
import math
import random

from inputs import MIB, burst_rate, daily_rate, next_arrival
from model import Config, Table
from throttle import check_insert

CFG = Config()
NO_MERGES = dict(max_bytes_at_max_space=0)


def run(config, until=math.inf, max_events=math.inf):
    table = Table(config)
    table.start()
    table.engine.run(until, max_events, after_event=table.check_invariants)
    return table


def test_delay_formula():
    small = 10 * MIB
    assert check_insert(999, 999 * small, CFG) == 0
    assert check_insert(1000, 1000 * small, CFG) == 10  # 1000 * 1 / 2000 rounds to 0, min_delay_to_insert_ms wins
    assert check_insert(2000, 2000 * small, CFG) == 500  # 1000 * 1001 / 2000
    assert check_insert(2999, 2999 * small, CFG) == 1000  # over == allowed, max delay
    assert check_insert(3000, 3000 * small, CFG) is None


def test_large_parts_disable_throttling_but_not_the_total_limit():
    large = 2 * 1024 * MIB
    assert check_insert(2000, 2000 * large, CFG) == 0
    assert check_insert(5000, 5000 * large, CFG) == 0
    assert check_insert(100000, 100000 * large, CFG) is None


def test_one_client_without_merges_sums_every_delay():
    # the client is sequential, so the n-th insert sees exactly n - 1 parts
    table = run(Config(arrivals="closed", clients=1, think_time=0.1, **NO_MERGES), until=3000)
    assert len(table.parts) == 3000 and table.rejected > 0
    assert table.delayed == 2000
    assert table.delay_total_ms == sum(check_insert(n, n * 10 * MIB, CFG) for n in range(1000, 3000))


def test_open_model_overshoots_the_rejection_threshold():
    # inserts accepted just below the threshold are still waiting out their delay when others arrive
    table = run(Config(insert_rate=20, **NO_MERGES), until=600)
    assert 3000 < len(table.parts) < 3100 and table.rejected > 0


def test_large_parts_never_throttle():
    config = Config(arrivals="closed", clients=1, think_time=0.1, insert_bytes_mean=2048 * MIB, insert_bytes_cv=0, **NO_MERGES)
    table = run(config, until=600)
    assert len(table.parts) > 3000 and table.delayed == table.rejected == 0


def test_closed_throughput_is_clients_over_think_time():
    # no throttling, zero response time: X = N / Z
    table = run(Config(arrivals="closed", clients=4, think_time=2.0), until=10**4)
    assert math.isclose(table.arrivals / 10**4, 2.0, rel_tol=0.03)


def test_throttling_slows_closed_clients_down():
    # Little's law for the client cycle: X = N / (Z + R) with R the mean delay, stopped before any rejection
    config = Config(arrivals="closed", clients=4, think_time=0.5, parts_to_delay_insert=10, **NO_MERGES)
    table = run(config, until=400)
    delay = table.delay_total_ms / 1000 / table.last_block
    assert table.rejected == 0 and delay > 0.1
    assert math.isclose(table.last_block / 400, 4 / (0.5 + delay), rel_tol=0.05)


def count_arrivals(amplitude, burst, days):
    rate, peak = daily_rate(1.0, amplitude, 14 * 3600)
    candidates, thinning = random.Random(1), random.Random(2)
    t, times = 0.0, []
    while t < days * 86400:
        t = next_arrival(t, rate, peak, candidates, thinning)
        times.append(t)
    if burst:
        # the burst is a second process on top of the first, with its own streams
        extra, extra_peak = burst_rate(rate, peak, burst)
        candidates, thinning = random.Random(3), random.Random(4)
        t = burst[0]
        while (t := next_arrival(t, extra, extra_peak, candidates, thinning, burst[0] + burst[1])) is not None:
            times.append(t)
        times.sort()
    return times


def test_daily_profile():
    times = count_arrivals(0.5, None, 30)
    peak = sum(1 for t in times if abs(t % 86400 - 14 * 3600) < 1800)
    trough = sum(1 for t in times if abs(t % 86400 - 2 * 3600) < 1800)
    # the cosine averages to 0.989 over the hour, so the ratio is 1.4945 / 0.5055
    assert 2.8 < peak / trough < 3.1
    assert math.isclose(len(times), 30 * 86400, rel_tol=0.01)


def test_burst():
    times = count_arrivals(0.0, (3600, 3600, 3.0), 1)
    before = sum(1 for t in times if t < 3600)
    during = sum(1 for t in times if 3600 <= t < 7200)
    assert 2.8 < during / before < 3.2


if __name__ == "__main__":
    for name, test in list(globals().items()):
        if name.startswith("test_"):
            test()
            print("ok", name)
