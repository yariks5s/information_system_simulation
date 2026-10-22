"""experiments of RFC section 9 into results/: python3 run_experiments.py [--quick] [name ...]"""
import json
import math
import os
import sys
import time
from dataclasses import replace

import numpy as np

import experiments
import stats
from calibrate import calibrated_config

QUICK = "--quick" in sys.argv
SEEDS = range(2 if QUICK else 10)
HORIZON = 600.0 if QUICK else 3600.0
WARMUP = 120.0 if QUICK else 600.0
# candidate warm-ups for welch; the longest still leaves a third of the horizon
WARMUPS = (120.0, 240.0) if QUICK else (600.0, 1200.0, 1800.0, 2400.0)
STEP = 30.0
OUT = "results_quick" if QUICK else "results"
KEYS = ("parts_mean", "busy_threads_mean", "all_threads_busy", "fresh_waiting_mean", "fresh_lifetime_mean",
        "merge_duration_mean", "write_amplification", "insert_rate", "delayed_fraction", "rejected_fraction",
        "nospace_fraction", "delay_mean_ms", "little_relative_error", "fresh_rate", "merges_aborted")
MB = 1e6
with open("calibration.json") as f:
    CAL = json.load(f)["model"]
PROJECTION = tuple(CAL["projection_aux"])
INDEX = tuple(CAL["index_aux"])


def base(**overrides):
    return calibrated_config(**overrides)


def aggregate(summaries):
    out = {k: stats.confidence_interval([s[k] for s in summaries]) for k in KEYS}
    for name in ("parts_quantiles", "fresh_waiting_quantiles", "fresh_lifetime_quantiles", "merge_duration_quantiles", "delay_quantiles_ms"):
        for q in (0.5, 0.9, 0.99):
            out[f"{name}_{q}"] = stats.confidence_interval([s[name][q] for s in summaries])
    return out


def mean_series(series):
    return {key: np.mean([s[key] for s in series], axis=0).tolist() for key in series[0]}


def save(name, payload):
    os.makedirs(OUT, exist_ok=True)
    with open(f"{OUT}/{name}.json", "w") as f:
        json.dump(payload, f, indent=1)


def welch_warmup(fresh, grid):
    index = stats.warmup_end(fresh, window=5)
    return float(grid[index]) if index < len(grid) - 5 else None


def settled(welch, warmups):
    return welch is not None and welch <= warmups[-1]


def common_warmup(welches, warmups):
    """rows of one table are compared, so they share the shortest warm-up covering every curve that settles"""
    need = max((w for w in welches if settled(w, warmups)), default=warmups[0])
    return next(w for w in warmups if w >= need)


def sweep(configs, until=HORIZON, warmups=WARMUPS):
    g = np.arange(0, until + STEP, STEP)
    results = stats.replicate_many(configs, until, warmups, SEEDS, grid=g)
    series = [mean_series(curves) for _, curves in results]
    # fresh parts, not all: one growing partition keeps adding parts like the log of its size
    welches = [welch_warmup(np.array(s["fresh"]), g) for s in series]
    warmup = common_warmup(welches, warmups)
    runs = []
    for (summaries, _), s, welch in zip(results, series, welches):
        per_seed = [x[warmup] for x in summaries]
        runs.append(dict(stats=aggregate(per_seed), series=s, per_seed=per_seed, warmup=warmup, welch_warmup=welch,
                         stationary=settled(welch, warmups), per_warmup=summaries,
                         # every warm-up is kept so the choice can be revisited without a rerun
                         stats_by_warmup={str(int(w)): aggregate([s[w] for s in summaries]) for w in warmups}))
    return runs, g


def strip(runs):
    return [{k: v for k, v in run.items() if k != "per_warmup"} for run in runs]


def e1_load():
    rates = [25, 50, 100, 150, 200, 225, 250, 275, 300]
    runs, grid = sweep([base(insert_rate=r) for r in rates])
    save("e1_load", dict(rates=rates, grid=grid.tolist(), runs=strip(runs)))


def e2_batch():
    data_rate = 180 * MB
    sizes = [0.29 * MB, 0.9 * MB, 3.6 * MB, 14.4 * MB]
    pools = [4, 16]
    configs = [base(insert_rate=data_rate / size, insert_bytes_mean=size, threads=pool) for pool in pools for size in sizes]
    runs, grid = sweep(configs)
    save("e2_batch", dict(data_rate=data_rate, sizes=sizes, pools=pools, grid=grid.tolist(), runs=strip(runs)))


def e3_boundary():
    sizes = [0.9 * MB, 3.6 * MB, 14.4 * MB]
    variants = {"pool 16": dict(threads=16), "pool 4": dict(threads=4), "pool 16 + projection": dict(threads=16, aux=(PROJECTION,))}
    configs, guess, labels = [], [], []
    for label, overrides in variants.items():
        for size in sizes:
            # guard off: with it large partitions are never throttled and the bound would measure the guard
            config = base(insert_bytes_mean=size, max_avg_part_size_for_too_many_parts=0, **overrides)
            # rough capacity, assuming write amplification of about 5
            capacity = config.threads * config.merge_bytes_per_second / (5 * size * (1 + sum(d for _, d in config.aux)))
            configs.append(config)
            guess.append(capacity)
            labels.append((label, size))
    seeds = range(2 if QUICK else 6)
    until = 300.0 if QUICK else 1800.0
    bounds, history = experiments.boundaries(configs, [g * 0.6 for g in guess], [g * 1.6 for g in guess], until, seeds)
    save("e3_boundary", dict(labels=labels, guess=guess, bounds=bounds, history=history, until=until, seeds=list(seeds)))


def e4_selector():
    rate = 150
    simple = [2, 3, 5, 8, 12, 20]
    tiered = [2, 3, 4, 6, 8, 12]
    configs = [base(insert_rate=rate, base=b) for b in simple] + [base(insert_rate=rate, selector="tiered", base=b) for b in tiered]
    runs, _ = sweep(configs)
    save("e4_selector", dict(rate=rate, simple=simple, tiered=tiered, runs=strip(runs)))


def e5_policy():
    rates = [200, 250]
    policies = ["round_robin", "shortest_task_first"]
    configs = [base(insert_rate=r, scheduling_policy=p) for r in rates for p in policies]
    runs, _ = sweep(configs)
    differences = {}
    for i, rate in enumerate(rates):
        a, b = runs[2 * i]["per_seed"], runs[2 * i + 1]["per_seed"]
        differences[rate] = {"warmup": runs[2 * i]["warmup"]}
        differences[rate].update({k: stats.paired_difference(a, b, key=lambda s, k=k: s[k]) for k in KEYS})
        differences[rate]["merge_duration_p99"] = stats.paired_difference(a, b, key=lambda s: s["merge_duration_quantiles"][0.99])
    save("e5_policy", dict(rates=rates, policies=policies, runs=strip(runs), differences=differences))


def e6_feedback():
    offered = 350
    open_input = dict(insert_rate=offered)
    # 35 clients thinking 0.1 s offer 350/s, and a 1 s delay cuts that up to 11 times
    closed_input = dict(arrivals="closed", clients=35, think_time=0.1)
    variants = {"open, guard": open_input, "closed, guard": closed_input,
                "open, no guard": dict(open_input, max_avg_part_size_for_too_many_parts=0),
                "closed, no guard": dict(closed_input, max_avg_part_size_for_too_many_parts=0)}
    runs, grid = sweep([base(**v) for v in variants.values()])
    save("e6_feedback", dict(offered=offered, variants=list(variants), grid=grid.tolist(), runs=strip(runs)))


def e7_burst():
    factors = [1.0, 1.5, 2.0, 3.0]
    start, length = (300.0, 60.0) if QUICK else (1800.0, 300.0)
    until = HORIZON * 1.5
    g = np.arange(0, until + 10.0, 10.0)
    configs = [base(insert_rate=150, burst=(start, length, f)) for f in factors]
    results = stats.pmap(_burst_job, [(replace(c, seed=s), until, g) for c in configs for s in SEEDS])
    n = len(SEEDS)
    # factors[0] must be 1.0: the same seed without a burst is the reference
    reference = [np.array(r) for r in results[:n]]
    after = np.searchsorted(g, start + length)
    runs = []
    for i, factor in enumerate(factors):
        chunk = [np.array(r) for r in results[i * n : (i + 1) * n]]
        recovery = []
        for burst, ref in zip(chunk, reference):
            within = np.nonzero(burst[after:] <= 1.1 * ref[after:])[0]
            recovery.append(float(g[after + within[0]] - (start + length)) if len(within) else math.inf)
        runs.append(dict(factor=factor, series=np.mean(chunk, axis=0).tolist(), peak=float(np.mean([c.max() for c in chunk])),
                         recovery=stats.confidence_interval(recovery) if all(map(math.isfinite, recovery)) else None,
                         recovery_per_seed=[r if math.isfinite(r) else None for r in recovery]))
    save("e7_burst", dict(factors=factors, burst=(start, length), grid=g.tolist(), runs=runs))


def _burst_job(job):
    from model import Table

    config, until, grid = job
    table = Table(config)
    table.start()
    table.engine.run(until)
    return stats.series(table, grid).tolist()


def e8_aux():
    variants = {"none": (), "bloom_filter index": (INDEX,), "projection": (PROJECTION,), "projection + index": (PROJECTION, INDEX)}
    runs, _ = sweep([base(insert_rate=100, aux=a) for a in variants.values()])
    save("e8_aux", dict(variants=list(variants), runs=strip(runs)))


def e9_factorial():
    data_rate = 180 * MB
    factors = {
        "insert size": (lambda c: replace(c, insert_bytes_mean=0.9 * MB, insert_rate=data_rate / (0.9 * MB)),
                        lambda c: replace(c, insert_bytes_mean=3.6 * MB, insert_rate=data_rate / (3.6 * MB))),
        "threads": (8, 16),
        "base": (3.0, 8.0),
        "scheduling_policy": ("round_robin", "shortest_task_first"),
        "projection": (lambda c: c, lambda c: replace(c, aux=(PROJECTION,))),
    }
    responses = ("parts_mean", "write_amplification", "fresh_lifetime_mean", "busy_threads_mean", "delayed_fraction")
    seeds = range(2 if QUICK else 6)
    g = np.arange(0, HORIZON + STEP, STEP)

    welches = []

    def one_warmup(curves):
        welches.extend(welch_warmup(np.array(mean_series(c)["fresh"]), g) for c in curves)
        return common_warmup(welches, WARMUPS)

    until = HORIZON
    results, effects, warmup = experiments.factorial(base(), factors, until, WARMUPS, responses, seeds, grid=g, choose=one_warmup)
    save("e9_factorial", dict(factors=list(factors), responses=responses, seeds=len(seeds), until=until, warmup=warmup, welch=welches,
                              runs=[dict(signs=r["signs"], means=r["means"], per_seed={k: [s[k] for s in r["summaries"]] for k in responses})
                                    for r in results], effects=effects))


def e10_partitions():
    rotation = dict(partition_seconds=120.0 if QUICK else 600.0, retention_partitions=3)
    open_variants = {"one partition": {}, "rotation": rotation, "rotation, 10% late inserts": dict(rotation, late_insert_fraction=0.1)}
    open_runs, open_grid = sweep([base(insert_rate=150, **v) for v in open_variants.values()], until=HORIZON * 2)
    closed = dict(arrivals="closed", clients=35, think_time=0.1)
    closed_variants = {"one partition": {}, "rotation": rotation}
    closed_runs, closed_grid = sweep([base(**closed, **v) for v in closed_variants.values()])
    save("e10_partitions", dict(rotation=rotation, open=dict(variants=list(open_variants), grid=open_grid.tolist(), runs=strip(open_runs)),
                                closed=dict(variants=list(closed_variants), grid=closed_grid.tolist(), runs=strip(closed_runs))))


def _disk_job(job):
    from model import Table
    from selector import max_source_parts_bytes

    config, until = job
    table = Table(config)
    table.start()
    rows = []
    for t in np.arange(0, until + STEP, STEP):
        table.engine.run(t)
        used = table.disk_used()
        free = max(0.0, config.disk_bytes - used) if config.disk_bytes else None
        rows.append(dict(used=used, outdated=table.outdated_bytes, parts=len(table.parts), nospace=table.rejected_disk,
                         cap=max_source_parts_bytes(table.pool.max_tasks, len(table.pool.tasks), config, free)))
    series = {k: [r[k] for r in rows] for k in rows[0]}
    cap_drop = next((t for t, cap in zip(np.arange(0, until + STEP, STEP), series["cap"]) if cap < config.max_bytes_at_max_space), math.inf)
    first_nospace = table.history_nospace[0] if table.history_nospace else math.inf
    tail = 600.0
    arrivals = sum(1 for t, _ in table.history_inserts if t >= until - tail)
    nospace = sum(1 for t in table.history_nospace if t >= until - tail)
    return stats.summary(table), series, dict(first_nospace=first_nospace, cap_drop=float(cap_drop),
                                              nospace_last_10_min=nospace / arrivals if arrivals else math.nan)


def e11_disk():
    until = 600.0 if QUICK else 6000.0
    disk = int((0.3 if QUICK else 2.0) * 10**12)
    variants = {"no limit": {}, "2 TB, old_parts_lifetime 480 s": dict(disk_bytes=disk), "2 TB, old_parts_lifetime 60 s": dict(disk_bytes=disk, old_parts_lifetime=60.0)}
    jobs = [(base(insert_rate=100, seed=seed, **v), until) for v in variants.values() for seed in SEEDS]
    results = stats.pmap(_disk_job, jobs)
    n = len(SEEDS)
    runs = []
    for i in range(len(variants)):
        chunk = results[i * n : (i + 1) * n]
        events = {}
        for key in ("first_nospace", "cap_drop", "nospace_last_10_min"):
            values = [c[2][key] for c in chunk]
            # an interval only if every seed has a value, None per seed means none
            events[key] = stats.confidence_interval(values) if all(math.isfinite(v) for v in values) else None
            events[key + "_per_seed"] = [v if math.isfinite(v) else None for v in values]
        runs.append(dict(stats=aggregate([c[0] for c in chunk]), series=mean_series([c[1] for c in chunk]), **events))
    save("e11_disk", dict(disk_bytes=disk, variants=list(variants), grid=np.arange(0, until + STEP, STEP).tolist(), runs=runs))


EXPERIMENTS = {f.__name__: f for f in (e1_load, e2_batch, e3_boundary, e4_selector, e5_policy, e6_feedback, e7_burst, e8_aux, e9_factorial,
                                       e10_partitions, e11_disk)}

if __name__ == "__main__":
    names = [a for a in sys.argv[1:] if not a.startswith("--")] or list(EXPERIMENTS)
    for name in names:
        started = time.time()
        EXPERIMENTS[name]()
        print(f"{name}: {time.time() - started:.0f}s", flush=True)
