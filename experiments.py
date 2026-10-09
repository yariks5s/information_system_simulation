"""M8 experiment designs (RFC section 9): factorial screening and the stability boundary."""
import itertools
import math
from dataclasses import replace

import numpy as np

import stats


def apply_level(config, name, level):
    """A level is a value of the Config field `name`, or a callable config -> config."""
    return level(config) if callable(level) else replace(config, **{name: level})


def factorial(base_config, factors, until, warmup, responses, seeds):
    """Full 2^k design. factors: {name: (low, high)}. Returns the runs and, per response,
    the main effects and two-factor interactions (difference of means between the +1 and -1 halves)."""
    names = list(factors)
    design = list(itertools.product((-1, 1), repeat=len(names)))
    configs = []
    for signs in design:
        config = base_config
        for name, sign in zip(names, signs):
            config = apply_level(config, name, factors[name][0 if sign < 0 else 1])
        configs.append(config)
    results = []
    for signs, (summaries, _) in zip(design, stats.replicate_many(configs, until, warmup, seeds)):
        results.append(dict(signs=signs, summaries=summaries,
                            means={r: float(np.mean([s[r] for s in summaries])) for r in responses}))
    effects = {}
    for response in responses:
        y = np.array([row["means"][response] for row in results])
        x = np.array([row["signs"] for row in results], dtype=float)
        effects[response] = dict(
            main={n: float((x[:, i] * y).mean() * 2) for i, n in enumerate(names)},
            interactions={f"{a} x {b}": float((x[:, i] * x[:, j] * y).mean() * 2)
                          for (i, a), (j, b) in itertools.combinations(enumerate(names), 2)})
    return results, effects


def _time_to_throttle(job):
    """Model time of the first delayed or rejected insert, or inf if none before `until`."""
    from model import Table

    config, until = job
    table = Table(config)
    table.start()
    t = 0.0
    while t < until:
        t = min(until, t + 60.0)
        table.engine.run(t)
        if table.delayed or table.rejected:
            return next(at for at, delay in table.history_inserts if delay is None or delay > 0)
    return math.inf


def boundaries(configs, low, high, until, seeds, tolerance=0.05):
    """Largest insert rate at which no replication throttles within `until`, for every config at once.
    Bisection on a log scale; all configs advance together so one process pool serves all of them.
    low and high are per-config initial guesses, widened until they bracket the boundary."""
    seeds = list(seeds)
    low, high = list(low), list(high)
    history = [[] for _ in configs]

    def evaluate(rates, active):
        jobs = [(replace(configs[i], insert_rate=rates[i], seed=s), until) for i in active for s in seeds]
        times = stats.pmap(_time_to_throttle, jobs)
        n = len(seeds)
        result = {}
        for k, i in enumerate(active):
            chunk = times[k * n : (k + 1) * n]
            result[i] = all(math.isinf(t) for t in chunk)
            history[i].append(dict(rate=rates[i], stable=result[i], time_to_throttle=chunk))
        return result

    unbracketed = list(range(len(configs)))
    while unbracketed:
        ok_low = evaluate(low, unbracketed)
        ok_high = evaluate(high, unbracketed)
        for i in unbracketed:
            if not ok_low[i]:
                high[i], low[i] = low[i], low[i] / 2
            elif ok_high[i]:
                low[i], high[i] = high[i], high[i] * 2
        unbracketed = [i for i in unbracketed if not (ok_low[i] and not ok_high[i])]
    while True:
        active = [i for i in range(len(configs)) if (high[i] - low[i]) / low[i] > tolerance]
        if not active:
            return list(zip(low, high)), history
        middle = [math.sqrt(l * h) for l, h in zip(low, high)]
        ok = evaluate(middle, active)
        for i in active:
            if ok[i]:
                low[i] = middle[i]
            else:
                high[i] = middle[i]
