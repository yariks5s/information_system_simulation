"""merge cost fit of RFC 3.7 from system.part_log: python3 calibrate.py [--report | --refit | --workload name]"""
import json
import math
import sys

import numpy as np
from scipy import optimize, stats

import loadgen

# part names repeat across re-created tables, so take the latest uuid
LATEST = "(SELECT table_uuid FROM system.part_log WHERE database = '{db}' AND table = '{name}' ORDER BY event_time_microseconds DESC LIMIT 1)"

MERGES_SQL = """
SELECT m.part_name, any(m.duration_ms), any(m.size_in_bytes), count(), sum(s.size_in_bytes),
       any(arraySum(mapValues(m.projections_duration_ms))), any(toUnixTimestamp64Micro(m.event_time_microseconds)) / 1e6
FROM (SELECT * FROM system.part_log WHERE event_type = 'MergeParts' AND table_uuid = {latest}) AS m
ARRAY JOIN m.merged_from AS source
INNER JOIN (SELECT part_name, size_in_bytes FROM system.part_log
            WHERE event_type IN ('NewPart', 'MergeParts') AND table_uuid = {latest}) AS s
    ON s.part_name = source
GROUP BY m.part_name
FORMAT TSV"""

NEW_PARTS_SQL = "SELECT size_in_bytes FROM system.part_log WHERE event_type = 'NewPart' AND table_uuid = {latest} FORMAT TSV"


def collect(table):
    db, name = table.split(".")
    latest = LATEST.format(db=db, name=name)
    rows = [line.split("\t") for line in loadgen.query(MERGES_SQL.format(latest=latest)).splitlines()]
    # columns: duration_s, result_bytes, sources, source_bytes, projections_s, finished_at
    merges = np.array([[float(r[1]) / 1000, float(r[2]), float(r[3]), float(r[4]), float(r[5]) / 1000, float(r[6])] for r in rows])
    inserts = np.array([float(x) for x in loadgen.query(NEW_PARTS_SQL.format(latest=latest)).split()])
    return merges, inserts


def fit(merges):
    duration, source_bytes = merges[:, 0], merges[:, 3]

    def residuals(p):
        return np.log(duration) - np.log(p[0] + p[1] * source_bytes)

    guess = [0.01, 1 / 200e6]
    result = optimize.least_squares(residuals, guess, bounds=([0, 0], [np.inf, np.inf]), x_scale=guess)
    c0, c1 = result.x
    log_residual = residuals(result.x)
    sigma = log_residual.std(ddof=2)
    # log least squares fits the median, the model noise has mean 1
    mean_factor = math.exp(sigma**2 / 2)
    return dict(
        merge_fixed_seconds=c0 * mean_factor,
        merge_bytes_per_second=1 / (c1 * mean_factor),
        merge_noise_cv=math.sqrt(math.exp(sigma**2) - 1),
        checks=dict(
            merges=len(duration),
            log_residual_sigma=sigma,
            residual_size_spearman=stats.spearmanr(np.log(source_bytes), log_residual).statistic,
            log_residual_skew=float(stats.skew(log_residual)),
            log_residual_excess_kurtosis=float(stats.kurtosis(log_residual)),
            result_to_sources_size=float(np.median(merges[:, 1] / merges[:, 3])),
            result_to_sources_size_by_bytes=float(merges[:, 1].sum() / merges[:, 3].sum()),
            source_mib_range=[float(source_bytes.min() / 2**20), float(source_bytes.max() / 2**20)],
        ),
    )


def large_merges(merges, c0, speed):
    """two regimes split by result ratio: large merges shrink fresh bytes more and run slower (RFC 3.1, 3.7)"""
    ratio, size, duration = merges[:, 1] / merges[:, 3], merges[:, 3], merges[:, 0]
    split = (ratio.max() + ratio.min()) / 2
    threshold = float(size[ratio < split].min())  # the smallest merge in the second regime
    small, fresh = size < threshold, ratio < split  # a merge in the second regime has only fresh bytes
    residual = np.log(duration) - np.log(c0 + size / speed)
    return dict(result_ratio=float(np.median(ratio[small])),
                result_ratio_large=float(np.median(ratio[fresh])),
                large_merge_bytes=int(threshold),
                large_merge_time_factor=float(np.exp(residual[fresh].mean() - residual[small].mean())))


def insert_sizes(inserts):
    return dict(insert_bytes_mean=float(inserts.mean()), insert_bytes_cv=float(inserts.std() / inserts.mean()))


# name: (CREATE TABLE extra, rows per insert, inserts per second, seconds)
WORKLOADS = {
    "base": ("", 25000, 4, 600),
    "index": (", INDEX idx_url url TYPE bloom_filter GRANULARITY 4", 25000, 4, 600),
    "projection": (", PROJECTION by_event (SELECT * ORDER BY event, ts)", 25000, 4, 600),
    # without small merges the fixed cost per merge is not identifiable
    "small": ("", 2000, 10, 300),
}


def report():
    """part_log keeps the history of the dropped tables"""
    result, all_merges = {}, {}
    for name in WORKLOADS:
        merges, inserts = collect(f"default.cal_{name}")
        np.save(f"runs/calibration_{name}/merges.npy", merges)
        all_merges[name] = merges
        result[name] = {**fit(merges), **insert_sizes(inserts)}
        if name == "projection":
            # projection time over the rest of the merge, to cross-check δ
            projection, total = merges[:, 4], merges[:, 0]
            result[name]["projection_time_ratio"] = float(np.median(projection / (total - projection)))
    result["base_and_small"] = fit(np.concatenate([all_merges["base"], all_merges["small"]]))
    result["model"] = model_params(result, all_merges["base"])
    return result


def model_params(result, base_merges):
    base, cost = result["base"], result["base_and_small"]
    model = {k: cost[k] for k in ("merge_fixed_seconds", "merge_bytes_per_second", "merge_noise_cv")}
    model.update({k: base[k] for k in ("insert_bytes_mean", "insert_bytes_cv")})
    for name in ("index", "projection"):
        # s: extra bytes per base byte; δ: extra time that makes the model merge at the measured speed
        storage = result[name]["insert_bytes_mean"] / base["insert_bytes_mean"] - 1
        time = (1 + storage) * cost["merge_bytes_per_second"] / result[name]["merge_bytes_per_second"] - 1
        model[f"{name}_aux"] = [storage, time]
    model.update(large_merges(base_merges, cost["merge_fixed_seconds"], cost["merge_bytes_per_second"]))
    return model


def refit():
    """offline: only base and index kept their merges, the other fits stay as stored"""
    with open("calibration.json") as f:
        result = json.load(f)
    merges = {name: np.load(f"runs/calibration_{name}/merges.npy") for name in ("base", "index")}
    for name, m in merges.items():
        result[name].update(fit(m))
    if "projection_time_share" in result["projection"]:
        result["projection"]["projection_time_ratio"] = result["projection"].pop("projection_time_share")
    result["model"] = model_params(result, merges["base"])
    with open("calibration.json", "w") as f:
        json.dump(result, f, indent=1)
    print(json.dumps(result["model"], indent=1))


def main():
    for name in WORKLOADS:
        run_workload(name)
        print("done", name, flush=True)
    write_report()


def write_report():
    result = report()
    with open("calibration.json", "w") as f:
        json.dump(result, f, indent=1)
    print(json.dumps(result, indent=1))


def calibrated_config(path="calibration.json", **overrides):
    from model import Config

    with open(path) as f:
        model = json.load(f)["model"]
    keys = ("merge_fixed_seconds", "merge_bytes_per_second", "merge_noise_cv", "insert_bytes_mean", "insert_bytes_cv",
            "result_ratio", "result_ratio_large", "large_merge_bytes", "large_merge_time_factor")
    return Config(**{**{k: model[k] for k in keys}, **overrides})


def run_workload(name):
    extra, rows, rate, duration = WORKLOADS[name]
    table = f"default.cal_{name}"
    loadgen.run(table, f"runs/calibration_{name}", duration, rows, rate=rate, extra=extra)
    loadgen.query(f"DROP TABLE {table} SYNC")


if __name__ == "__main__":
    if sys.argv[1:] == ["--report"]:
        write_report()
    elif sys.argv[1:] == ["--refit"]:
        refit()
    elif sys.argv[1:2] == ["--workload"]:
        run_workload(sys.argv[2])
    else:
        main()
