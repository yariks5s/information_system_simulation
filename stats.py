"""characteristics of RFC section 6 from recorded facts, for any window [warmup, end] without a rerun"""
import math
import multiprocessing
from collections import defaultdict

import numpy as np
from scipy import stats as sps


def step_stats(changes, start, end, transform=None):
    """time-weighted mean and {value: share of time} of a counter that starts at 0"""
    time_in = defaultdict(float)
    value, last = 0, start
    for t, delta in sorted(changes):
        if t > end:
            break
        if t > start:
            time_in[value] += t - last
            last = t
        value += delta
    time_in[value] += end - last
    if transform:
        merged = defaultdict(float)
        for v, dt in time_in.items():
            merged[transform(v)] += dt
        time_in = merged
    length = end - start
    return sum(v * dt for v, dt in time_in.items()) / length, {v: dt / length for v, dt in sorted(time_in.items())}


def quantiles(values, qs=(0.5, 0.9, 0.99)):
    if not len(values):
        return {q: math.nan for q in qs}
    return {q: float(np.quantile(values, q)) for q in qs}


def distribution_quantiles(fractions, qs=(0.5, 0.9, 0.99)):
    values, weights = zip(*sorted(fractions.items()))
    cumulative = np.cumsum(weights)
    return {q: values[min(int(np.searchsorted(cumulative, q - 1e-12)), len(values) - 1)] for q in qs}


def parts_changes(table, level=None):
    changes = []
    for part in table.history_parts:
        if level is None or part.level == level:
            changes.append((part.created_at, 1))
            if part.removed_at is not None:
                changes.append((part.removed_at, -1))
    return changes


def summary(table, warmup=0.0, end=None):
    end = table.engine.now if end is None else end
    length = end - warmup
    threads = table.cfg.threads
    parts_mean, parts_distribution = step_stats(parts_changes(table), warmup, end)
    fresh_mean, _ = step_stats(parts_changes(table, level=0), warmup, end)
    task_changes = [c for a, d, _ in table.history_merges + table.history_aborted for c in ((a, 1), (d, -1))]
    task_changes += [(task.created_at, 1) for task in table.pool.tasks]
    busy_mean, busy_distribution = step_stats(task_changes, warmup, end, transform=lambda n: min(n, threads))

    fresh = [p for p in table.history_parts if p.level == 0]
    lifetime = np.array([p.removed_at - p.created_at for p in fresh if p.removed_at is not None and warmup <= p.removed_at <= end])
    waiting = np.array([p.picked_at - p.created_at for p in fresh if p.picked_at is not None and warmup <= p.picked_at <= end])
    created = sum(1 for p in fresh if warmup <= p.created_at <= end)
    merges = [(a, d, size) for a, d, size in table.history_merges if warmup <= d <= end]
    inserted = sum(p.size for p in fresh if warmup <= p.created_at <= end)

    inserts = [(t, delay) for t, delay in table.history_inserts if warmup <= t <= end]
    accepted = np.array([delay for _, delay in inserts if delay is not None], dtype=float)
    arrivals = len(inserts)
    result = dict(
        parts_mean=parts_mean,
        parts_quantiles=distribution_quantiles(parts_distribution),
        busy_threads_mean=busy_mean,
        all_threads_busy=busy_distribution.get(threads, 0.0),
        fresh_parts_mean=fresh_mean,
        fresh_lifetime_mean=float(lifetime.mean()) if len(lifetime) else math.nan,
        fresh_lifetime_quantiles=quantiles(lifetime),
        fresh_waiting_mean=float(waiting.mean()) if len(waiting) else math.nan,
        fresh_waiting_quantiles=quantiles(waiting),
        fresh_rate=created / length,  # committed inserts per second
        merges_aborted=sum(1 for _, d, _ in table.history_aborted if warmup <= d <= end),
        merge_duration_mean=float(np.mean([d - a for a, d, _ in merges])) if merges else math.nan,
        merge_duration_quantiles=quantiles(np.array([d - a for a, d, _ in merges])),
        write_amplification=sum(size for *_, size in merges) / inserted if inserted else math.nan,
        insert_rate=arrivals / length,
        delayed_fraction=float((accepted > 0).sum() / arrivals) if arrivals else math.nan,
        rejected_fraction=(arrivals - len(accepted)) / arrivals if arrivals else math.nan,
        nospace_fraction=sum(1 for t in table.history_nospace if warmup <= t <= end) / arrivals if arrivals else math.nan,
        delay_mean_ms=float(accepted.mean()) if len(accepted) else math.nan,
        delay_quantiles_ms=quantiles(accepted),
    )
    # self-check: little's law L = λW on the fresh parts
    result["little_relative_error"] = abs(fresh_mean - result["fresh_rate"] * result["fresh_lifetime_mean"]) / fresh_mean if fresh_mean else math.nan
    return result


def series(table, grid, level=None):
    changes = sorted(parts_changes(table, level))
    out, value, i = [], 0, 0
    for t in grid:
        while i < len(changes) and changes[i][0] <= t:
            value += changes[i][1]
            i += 1
        out.append(value)
    return np.array(out)


def largest_partition_series(table, grid):
    changes = []
    for part in table.history_parts:
        changes.append((part.created_at, part.partition, 1))
        if part.removed_at is not None:
            changes.append((part.removed_at, part.partition, -1))
    changes.sort(key=lambda c: c[0])
    counts, out, i = defaultdict(int), [], 0
    for t in grid:
        while i < len(changes) and changes[i][0] <= t:
            counts[changes[i][1]] += changes[i][2]
            i += 1
        out.append(max(counts.values(), default=0))
    return np.array(out)


def _run(job):
    from model import Table

    config, until, warmup, grid = job
    table = Table(config)
    table.start()
    table.engine.run(until)
    # a tuple of warm-ups costs no extra run, summary only reads recorded facts
    result = {w: summary(table, w) for w in warmup} if isinstance(warmup, tuple) else summary(table, warmup)
    if grid is None:
        return result, None
    return result, dict(parts=series(table, grid), fresh=series(table, grid, level=0), largest=largest_partition_series(table, grid))


def pmap(fn, jobs, workers=None):
    """fn must be module-level, the pool pickles it by name"""
    jobs = list(jobs)
    if workers == 1:
        return list(map(fn, jobs))
    with multiprocessing.get_context("fork").Pool(workers or min(len(jobs), multiprocessing.cpu_count())) as pool:
        return pool.map(fn, jobs, chunksize=1)


def replicate(config, until, warmup, seeds, grid=None, workers=None):
    """one run per seed; the same seeds across configs give common random numbers"""
    return replicate_many([config], until, warmup, seeds, grid, workers)[0]


def replicate_many(configs, until, warmup, seeds, grid=None, workers=None):
    """one pool for all configs keeps every core busy"""
    from dataclasses import replace

    seeds = list(seeds)
    jobs = [(replace(config, seed=seed), until, warmup, grid) for config in configs for seed in seeds]
    results = pmap(_run, jobs, workers)
    out = []
    for i in range(len(configs)):
        chunk = results[i * len(seeds) : (i + 1) * len(seeds)]
        out.append(([r[0] for r in chunk], [r[1] for r in chunk]))
    return out


def confidence_interval(values, level=0.95):
    values = np.asarray(values, dtype=float)
    n = len(values)
    half = sps.t.ppf((1 + level) / 2, n - 1) * values.std(ddof=1) / math.sqrt(n) if n > 1 else math.inf
    return float(values.mean()), float(half)


def paired_difference(a, b, key, level=0.95):
    """a and b must be in the same seed order"""
    return confidence_interval([key(y) - key(x) for x, y in zip(a, b)], level)


def welch(curves, window):
    """welch's procedure (law): centred moving average of the replication mean, m - window points long"""
    mean = np.mean(curves, axis=0)
    smoothed = np.empty(max(0, len(mean) - window), dtype=float)
    for i in range(len(smoothed)):
        half = min(window, i)
        smoothed[i] = mean[i - half : i + half + 1].mean()
    return smoothed


def warmup_end(curve, window=5, tolerance=0.05):
    """index where the warm-up ends, or len(curve) - window if the curve never settles"""
    smoothed = welch([curve], window)
    target = smoothed[len(smoothed) // 2 :].mean()
    if not target:
        return 0
    # std of first differences barely notices a slow trend
    noise = np.std(np.diff(np.asarray(curve, dtype=float)[len(curve) // 2 :])) / math.sqrt(2)
    # band no narrower than 3 standard errors of a smoothed point, or noise reads as a trend
    return warmup_index(smoothed, max(tolerance, 3 * noise / math.sqrt(2 * window + 1) / target))


def warmup_index(smoothed, tolerance=0.05):
    target = smoothed[len(smoothed) // 2 :].mean()
    outside = np.nonzero(np.abs(smoothed - target) > tolerance * target)[0]
    return int(outside[-1] + 1) if len(outside) else 0
