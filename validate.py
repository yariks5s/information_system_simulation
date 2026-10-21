"""live server vs model (RFC section 8): python3 validate.py live|compare open|closed|throttled"""
import csv
import json
import math
import sys

import numpy as np

import calibrate
import loadgen
import stats

WARMUP = 90.0
DURATION = 360.0
LIVE_RUNS = 3
MODEL_RUNS = 20

CASES = {
    "open": dict(load=dict(mode="open", rate=8, rows=10000), model=dict(arrivals="open", insert_rate=8)),
    "closed": dict(load=dict(mode="closed", clients=8, think=0.5, rows=10000), model=dict(arrivals="closed", clients=8, think_time=0.5)),
    # thresholds near the natural part count: throttling is frequent and sensitive to the tail
    "throttled": dict(load=dict(mode="open", rate=40, rows=2000, settings="parts_to_delay_insert = 15, parts_to_throw_insert = 45"),
                      model=dict(arrivals="open", insert_rate=40, parts_to_delay_insert=15, parts_to_throw_insert=45)),
}

FRESH_SQL = """
SELECT toUnixTimestamp64Micro(n.event_time_microseconds) / 1e6, n.size_in_bytes,
       toUnixTimestamp64Micro(s.start) / 1e6, toUnixTimestamp64Micro(m.finish) / 1e6
FROM (SELECT part_name, event_time_microseconds, size_in_bytes FROM system.part_log WHERE event_type = 'NewPart' AND table_uuid = {latest}) AS n
LEFT JOIN (SELECT arrayJoin(merged_from) AS source, event_time_microseconds AS start FROM system.part_log
           WHERE event_type = 'MergePartsStart' AND table_uuid = {latest}) AS s ON s.source = n.part_name
LEFT JOIN (SELECT arrayJoin(merged_from) AS source, event_time_microseconds AS finish FROM system.part_log
           WHERE event_type = 'MergeParts' AND table_uuid = {latest}) AS m ON m.source = n.part_name
SETTINGS join_use_nulls = 1
FORMAT TSV"""


INSERTS_SQL = """
SELECT ProfileEvents['DelayedInserts'], ProfileEvents['DelayedInsertsMilliseconds'], query_duration_ms
FROM system.query_log
WHERE type = 'QueryFinish' AND query_kind = 'Insert' AND has(tables, '{table}')
  AND event_time_microseconds BETWEEN fromUnixTimestamp64Micro({start}) AND fromUnixTimestamp64Micro({end})
FORMAT TSV"""


def insert_delays(table, start, end):
    # per query: system.events counts a sleep for every parallel sink of the INSERT SELECT, empty ones too
    rows = np.array([[float(x) for x in line.split("\t")] for line in loadgen.query(INSERTS_SQL.format(
        table=table, start=int(start * 1e6), end=int(end * 1e6))).splitlines()]).reshape(-1, 3)
    count, ms, duration = rows.T
    delay = np.divide(ms, count, out=np.zeros_like(ms), where=count > 0)
    return count > 0, delay, duration


def live_summary(table, run_dir):
    with open(f"{run_dir}/monitor.csv") as f:
        monitor = [{k: float(v) for k, v in row.items()} for row in csv.DictReader(f)]
    with open(f"{run_dir}/inserts.csv") as f:
        inserts = [row for row in csv.DictReader(f) if float(row["arrival"]) >= WARMUP]
    steady = [row for row in monitor if row["time"] >= WARMUP]
    parts = np.array([row["parts"] for row in steady])
    first, last = steady[0], steady[-1]
    accepted = sum(1 for row in inserts if row["status"] == "ok")

    db, name = table.split(".")
    latest = calibrate.LATEST.format(db=db, name=name)
    fresh = np.array([[math.nan if x == "\\N" else float(x) for x in line.split("\t")]
                      for line in loadgen.query(FRESH_SQL.format(latest=latest)).splitlines()])
    start, end = fresh[:, 0].min() + WARMUP, fresh[:, 0].max()
    window = fresh[(fresh[:, 0] >= start) & (fresh[:, 0] <= end - 60)]  # parts of the last minute may be unmerged
    lifetime = window[:, 3] - window[:, 0]
    waiting = window[:, 2] - window[:, 0]
    merges, _ = calibrate.collect(table)
    merged = merges[(merges[:, 5] >= start) & (merges[:, 5] <= end)]
    inserted = fresh[(fresh[:, 0] >= start) & (fresh[:, 0] <= end), 1].sum()
    delayed, delay, duration = insert_delays(table, start, end)
    return dict(
        parts_mean=float(parts.mean()),
        parts_quantiles={q: float(np.quantile(parts, q, method="inverted_cdf")) for q in (0.5, 0.9, 0.99)},
        busy_threads_mean=float(np.mean([min(row["pool_tasks"], 16) for row in steady])),
        fresh_lifetime_mean=float(np.nanmean(lifetime)),
        fresh_lifetime_quantiles=stats.quantiles(lifetime[~np.isnan(lifetime)]),
        fresh_waiting_mean=float(np.nanmean(waiting)),
        fresh_waiting_quantiles=stats.quantiles(waiting[~np.isnan(waiting)]),
        merge_duration_mean=float(merged[:, 0].mean()),
        write_amplification=float(merged[:, 3].sum() / inserted),
        insert_rate=len(inserts) / (DURATION - WARMUP),
        delayed_fraction=float(delayed.mean()),
        rejected_fraction=(len(inserts) - accepted) / len(inserts),
        delay_mean_ms=float(delay.mean()),
        # sinks sleep partly in sequence, so this exceeds delay_mean_ms
        latency_added_ms=float(duration.mean() - np.median(duration[~delayed])) if (~delayed).any() else math.nan,
        system_events_delayed_per_insert=(last["DelayedInserts"] - first["DelayedInserts"]) / len(inserts),
        insert_bytes=fresh[:, 1].tolist(),
    )


METRICS = ("parts_mean", "busy_threads_mean", "fresh_waiting_mean", "fresh_lifetime_mean", "merge_duration_mean",
           "write_amplification", "insert_rate", "delayed_fraction", "rejected_fraction", "delay_mean_ms")


def run_live(name):
    case, table = CASES[name], f"default.val_{name}"
    live = []
    for run in range(LIVE_RUNS):
        run_dir = f"runs/validation_{name}_{run}"
        loadgen.run(table, run_dir, DURATION, seed=run, **case["load"])
        live.append(live_summary(table, run_dir))
        loadgen.query(f"DROP TABLE {table} SYNC")
    with open(f"runs/validation_{name}_live.json", "w") as f:
        json.dump(live, f, indent=1)


def compare(name):
    with open(f"runs/validation_{name}_live.json") as f:
        live = json.load(f)
    # insert sizes are an input of the run, so the model takes them from its NewPart events
    sizes = np.concatenate([s.pop("insert_bytes") for s in live])
    config = calibrate.calibrated_config(**CASES[name]["model"], insert_bytes_mean=float(sizes.mean()),
                                         insert_bytes_cv=float(sizes.std() / sizes.mean()))
    model, _ = stats.replicate(config, DURATION, WARMUP, seeds=range(MODEL_RUNS))
    rows = []
    for metric in METRICS:
        live_mean, live_half = stats.confidence_interval([s[metric] for s in live])
        model_mean, model_half = stats.confidence_interval([s[metric] for s in model])
        rows.append(dict(metric=metric, live=live_mean, live_half=live_half, model=model_mean, model_half=model_half))
    with open(f"runs/validation_{name}.json", "w") as f:
        json.dump(dict(case=CASES[name], live=live, model=model, comparison=rows), f, indent=1, default=str)
    return rows


def show(name, rows):
    print(f"== {name}")
    print(f"{'metric':22} {'live':>22} {'model':>22} {'diff':>7}")
    for row in rows:
        diff = (row["model"] - row["live"]) / row["live"] if row["live"] else math.nan
        print(f"{row['metric']:22} {row['live']:12.4g} ± {row['live_half']:<7.2g} {row['model']:12.4g} ± {row['model_half']:<7.2g} {diff:+7.1%}")


if __name__ == "__main__":
    action, name = sys.argv[1:3]
    if action == "live":
        run_live(name)
    else:
        show(name, compare(name))
