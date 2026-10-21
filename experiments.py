"""experiment designs of RFC section 9: 2^k factorial screening and the stability boundary"""
import itertools
import math
from dataclasses import replace

import numpy as np

import stats


def apply_level(config, name, level):
    return level(config) if callable(level) else replace(config, **{name: level})


def factorial(base_config, factors, until, warmup, responses, seeds, grid=None, choose=None):
    names = list(factors)
    design = list(itertools.product((-1, 1), repeat=len(names)))
    configs = []
    for signs in design:
        config = base_config
        for name, sign in zip(names, signs):
            config = apply_level(config, name, factors[name][0 if sign < 0 else 1])
        configs.append(config)
    replicated = stats.replicate_many(configs, until, warmup, seeds, grid=grid)
    if choose:  # one warm-up for every cell, picked from all their curves
        warmup = choose([curves for _, curves in replicated])
        replicated = [([s[warmup] for s in summaries], curves) for summaries, curves in replicated]
    results = []
    for signs, (summaries, _) in zip(design, replicated):
        results.append(dict(signs=signs, summaries=summaries,
                            means={r: float(np.mean([s[r] for s in summaries])) for r in responses}))
    effects = {}
    x = np.array([row["signs"] for row in results], dtype=float)
    for response in responses:
        y = np.array([[s[response] for s in row["summaries"]] for row in results])  # rows x seeds

        # 2 * mean(contrast * y) is mean(+) - mean(-), per seed because each seed runs the whole design
        def effect(contrast):
            return stats.confidence_interval((contrast[:, None] * y).mean(axis=0) * 2)

        effects[response] = dict(
            main={n: effect(x[:, i]) for i, n in enumerate(names)},
            interactions={f"{a} x {b}": effect(x[:, i] * x[:, j]) for (i, a), (j, b) in itertools.combinations(enumerate(names), 2)})
    return results, effects, warmup


def _time_to_throttle(job):
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
    """log-scale bisection for the largest rate where no seed throttles; configs step together to share one pool"""
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
