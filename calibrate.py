"""M5 calibration (RFC 3.7): fit the merge cost to system.part_log of the live server.

    work = (c0 + c1 * bytes) * ε,  ε lognormal with mean 1

bytes is the sum of source part sizes on disk, the same quantity the model merges."""
import json
import math
import sys

import numpy as np
from scipy import optimize, stats

import loadgen

# only the latest table with this name: part names repeat across re-created tables
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
    merges = np.array([[float(r[1]) / 1000, float(r[2]), float(r[3]), float(r[4]), float(r[5]) / 1000, float(r[6])] for r in rows])
    inserts = np.array([float(x) for x in loadgen.query(NEW_PARTS_SQL.format(latest=latest)).split()])
    # columns: duration_s, result_bytes, sources, source_bytes, projections_s, finished_at
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
    # least squares on logs fits the median; the model's noise has mean 1, so scale by exp(sigma^2 / 2)
    mean_factor = math.exp(sigma**2 / 2)
    return dict(
        merge_fixed_seconds=c0 * mean_factor,
        merge_bytes_per_second=1 / (c1 * mean_factor),
        merge_noise_cv=math.sqrt(math.exp(sigma**2) - 1),
        checks=dict(
            merges=len(duration),
            log_residual_sigma=sigma,
            # no trend of residuals over size, and how far they are from normal on the log scale
            residual_size_spearman=stats.spearmanr(np.log(source_bytes), log_residual).statistic,
            log_residual_skew=float(stats.skew(log_residual)),
            log_residual_excess_kurtosis=float(stats.kurtosis(log_residual)),
            result_to_sources_size=float(np.median(merges[:, 1] / merges[:, 3])),
            result_to_sources_size_by_bytes=float(merges[:, 1].sum() / merges[:, 3].sum()),
            source_mib_range=[float(source_bytes.min() / 2**20), float(source_bytes.max() / 2**20)],
        ),
    )


def large_merges(merges, c0, speed):
    """RFC 3.1, 3.7: a merged part keeps result_ratio of its sources, but merges from a threshold of about 100 MiB up
    shrink the bytes that never went through such a merge once more, to result_ratio_large, and take
    large_merge_time_factor longer than the cost line gives for the same data."""
    ratio, size, duration = merges[:, 1] / merges[:, 3], merges[:, 3], merges[:, 0]
    split = (ratio.max() + ratio.min()) / 2
    threshold = float(size[ratio < split].min())  # the smallest merge in the second regime
    small, fresh = size < threshold, ratio < split  # all bytes of a merge with the second ratio are fresh
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
    # small parts make small merges, without them the fixed cost per merge is not identifiable
    "small": ("", 2000, 10, 300),
}


def report():
    """Fits every workload from system.part_log, which keeps the history after the tables are dropped."""
    result, all_merges = {}, {}
    for name in WORKLOADS:
        merges, inserts = collect(f"default.cal_{name}")
        np.save(f"runs/calibration_{name}/merges.npy", merges)
        all_merges[name] = merges
        result[name] = {**fit(merges), **insert_sizes(inserts)}
        if name == "projection":
            # projection time over the rest of the merge, a cross-check of its δ
            projection, total = merges[:, 4], merges[:, 0]
            result[name]["projection_time_ratio"] = float(np.median(projection / (total - projection)))
    # the base cost line over small and large merges of the same schema
    result["base_and_small"] = fit(np.concatenate([all_merges["base"], all_merges["small"]]))
    result["model"] = model_params(result, all_merges["base"])
    return result


def model_params(result, base_merges):
    """The parameters the model takes: cost line, insert sizes, auxiliary structures, merged part size."""
    base, cost = result["base"], result["base_and_small"]
    model = {k: cost[k] for k in ("merge_fixed_seconds", "merge_bytes_per_second", "merge_noise_cv")}
    model.update({k: base[k] for k in ("insert_bytes_mean", "insert_bytes_cv")})
    for name in ("index", "projection"):
        # s: extra bytes on disk per base byte; δ: extra merge time at equal base bytes, against the speed
        # the model uses, so that the modelled table merges as fast as the measured one
        storage = result[name]["insert_bytes_mean"] / base["insert_bytes_mean"] - 1
        time = (1 + storage) * cost["merge_bytes_per_second"] / result[name]["merge_bytes_per_second"] - 1
        model[f"{name}_aux"] = [storage, time]
    model.update(large_merges(base_merges, cost["merge_fixed_seconds"], cost["merge_bytes_per_second"]))
    return model


def refit():
    """Recomputes calibration.json from the stored merges of the base and index workloads, without a server.
    The small and projection workloads kept only their fits, so those are taken as stored."""
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
    """Config with the merge cost and insert sizes measured on the live server."""
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
