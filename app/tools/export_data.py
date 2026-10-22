"""writes app/src/data/calibration.js and results.js from calibration.json and results/"""
import json
import math
import os

root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
os.chdir(root)

MB = 1e6


def load(path):
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return json.load(f)


def mean_half(run, key):
    mean, half = run["stats"][key]
    if not math.isfinite(mean):
        return None
    return [round(mean, 6), round(half, 6) if math.isfinite(half) else 0.0]


def seeds_with(values):
    return sum(v is not None for v in values)


def thin(series, step):
    return [round(v, 2) for v in series[::step]]


def results():
    out = {}
    d = load("results/e1_load.json")
    if d:
        keys = ["parts_mean", "parts_quantiles_0.99", "busy_threads_mean", "all_threads_busy", "write_amplification",
                "fresh_waiting_mean", "fresh_waiting_quantiles_0.99", "merge_duration_mean", "merge_duration_quantiles_0.99",
                "fresh_lifetime_mean"]
        out["e1"] = dict(rates=d["rates"], metrics={k: [mean_half(r, k) for r in d["runs"]] for k in keys},
                         grid=thin(d["grid"], 2), series={r: thin(run["series"]["parts"], 2) for r, run in zip(d["rates"], d["runs"])})
    d = load("results/e2_batch.json")
    if d:
        n = len(d["sizes"])
        out["e2"] = dict(sizes=[s / MB for s in d["sizes"]], pools=d["pools"],
                         metrics={k: [[mean_half(r, k) for r in d["runs"][i * n:(i + 1) * n]] for i in range(len(d["pools"]))]
                                  for k in ("parts_mean", "write_amplification", "busy_threads_mean")})
    d = load("results/e3_boundary.json")
    if d:
        variants = []
        for label, size_bytes in d["labels"]:
            if label not in variants:
                variants.append(label)
        out["e3"] = dict(variants=[dict(name=v, points=[[size / MB, low, high, low * size / MB]
                                                      for (label, size), (low, high) in zip(d["labels"], d["bounds"]) if label == v])
                                   for v in variants], until=d["until"])
    d = load("results/e4_selector.json")
    if d:
        n = len(d["simple"])
        out["e4"] = dict(rate=d["rate"], selectors=[
            dict(name="SimpleMergeSelector", bases=d["simple"], wa=[mean_half(r, "write_amplification") for r in d["runs"][:n]],
                 parts=[mean_half(r, "parts_mean") for r in d["runs"][:n]], busy=[mean_half(r, "busy_threads_mean") for r in d["runs"][:n]]),
            dict(name="tiered", bases=d["tiered"], wa=[mean_half(r, "write_amplification") for r in d["runs"][n:]],
                 parts=[mean_half(r, "parts_mean") for r in d["runs"][n:]], busy=[mean_half(r, "busy_threads_mean") for r in d["runs"][n:]])])
    d = load("results/e5_policy.json")
    if d:
        out["e5"] = dict(rates=d["rates"], differences={r: {k: v for k, v in diffs.items() if k in
                                                          ("parts_mean", "fresh_waiting_mean", "merge_duration_mean", "merge_duration_p99", "write_amplification")}
                                                      for r, diffs in d["differences"].items()},
                         runs=[dict(rate=d["rates"][i // 2], policy=d["policies"][i % 2], parts=mean_half(r, "parts_mean"),
                                    merge_p99=mean_half(r, "merge_duration_quantiles_0.99"), wa=mean_half(r, "write_amplification"))
                               for i, r in enumerate(d["runs"])])
    d = load("results/e6_feedback.json")
    if d and "variants" in d:
        out["e6"] = dict(offered=d["offered"], grid=thin(d["grid"], 2), variants=[
            dict(name=v, parts=thin(r["series"]["parts"], 2), rate=mean_half(r, "fresh_rate"), rejected=mean_half(r, "rejected_fraction"),
                 delayed=mean_half(r, "delayed_fraction"), parts_mean=mean_half(r, "parts_mean"))
            for v, r in zip(d["variants"], d["runs"])])
    d = load("results/e7_burst.json")
    if d:
        out["e7"] = dict(burst=d["burst"], grid=thin(d["grid"], 3),
                         runs=[dict(factor=r["factor"], series=thin(r["series"], 3), peak=round(r["peak"], 1),
                                    recovery=r["recovery"] and [round(r["recovery"][0], 1), round(r["recovery"][1], 1) if math.isfinite(r["recovery"][1]) else 0.0],
                                    recovered=seeds_with(r["recovery_per_seed"]), seeds=len(r["recovery_per_seed"]))
                               for r in d["runs"]])
    d = load("results/e8_aux.json")
    if d:
        out["e8"] = dict(variants=d["variants"], runs=[{k: mean_half(r, k) for k in ("parts_mean", "busy_threads_mean", "merge_duration_mean", "write_amplification")}
                                                      for r in d["runs"]])
    d = load("results/e9_factorial.json")
    if d:
        out["e9"] = dict(factors=d["factors"], responses=[r for r in d["responses"] if r != "delayed_fraction"], effects=d["effects"])
    d = load("results/e10_partitions.json")
    if d:
        out["e10"] = dict(rotation=d["rotation"], **{part: dict(grid=thin(d[part]["grid"], 2), variants=[
            dict(name=v, parts=thin(r["series"]["parts"], 2), largest=thin(r["series"]["largest"], 2), stats={k: mean_half(r, k) for k in (
                "parts_mean", "write_amplification", "insert_rate", "delayed_fraction", "rejected_fraction")})
            for v, r in zip(d[part]["variants"], d[part]["runs"])]) for part in ("open", "closed")})
    d = load("results/e11_disk.json")
    if d:
        out["e11"] = dict(disk_bytes=d["disk_bytes"], grid=thin(d["grid"], 2), variants=[
            dict(name=v, used=thin(r["series"]["used"], 2), outdated=thin(r["series"]["outdated"], 2), parts=thin(r["series"]["parts"], 2),
                 first_nospace=r["first_nospace"], cap_drop=r["cap_drop"], nospace_last_10_min=r["nospace_last_10_min"],
                 first_nospace_seeds=seeds_with(r["first_nospace_per_seed"]), cap_drop_seeds=seeds_with(r["cap_drop_per_seed"]),
                 seeds=len(r["cap_drop_per_seed"]), stats={k: mean_half(r, k) for k in (
                     "parts_mean", "write_amplification", "delayed_fraction", "rejected_fraction", "nospace_fraction")})
            for v, r in zip(d["variants"], d["runs"])])
    cases = []
    for key, title in (("open", "відкритий потік, 8 вставок/с"), ("closed", "8 замкнених клієнтів"), ("throttled", "40 вставок/с, низькі пороги")):
        d = load(f"runs/validation_{key}.json")
        if d:
            cases.append(dict(key=key, title=title, rows=d["comparison"]))
    out["validation"] = cases
    out["calibration"] = load("calibration.json")
    return out



with open("calibration.json") as f:
    model = json.load(f)["model"]
calibrated = {k: model[k] for k in ("merge_fixed_seconds", "merge_bytes_per_second", "merge_noise_cv", "insert_bytes_mean", "insert_bytes_cv",
                                     "result_ratio", "result_ratio_large", "large_merge_bytes", "large_merge_time_factor")}
aux = {"index": model["index_aux"], "projection": model["projection_aux"]}
data = results()  # before writing, so a failure keeps both old modules
out = os.path.join("app", "src", "data")
with open(os.path.join(out, "calibration.js"), "w") as f:
    f.write("// generated by tools/export_data.py from calibration.json\n")
    f.write(f"export const CALIBRATED = {json.dumps(calibrated, indent=2)};\n")
    f.write(f"export const AUX = {json.dumps(aux, indent=2)};\n")
with open(os.path.join(out, "results.js"), "w") as f:
    f.write("// generated by tools/export_data.py from results/*.json and runs/validation_*.json\n")
    f.write("export const RESULTS = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n")
print("wrote", os.listdir(out))
