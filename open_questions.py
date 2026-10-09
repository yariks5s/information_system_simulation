"""Open questions of the validation (RFC section 8): does a delay between a trigger and the assignee run explain
both gaps, the higher write amplification of the model and the lighter tail of its parts count?

    python3 open_questions.py   (no server needed: compares with the stored live runs)"""
import json
import sys

import numpy as np

import stats
from calibrate import calibrated_config

LATENCIES = [0.0, 0.01, 0.03, 0.1, 0.3]
CASES = ("open", "closed", "throttled")
METRICS = ("parts_mean", "write_amplification", "fresh_waiting_mean", "delayed_fraction")


def live(case):
    with open(f"runs/validation_{case}_live.json") as f:
        runs = json.load(f)
    sizes = np.concatenate([r["insert_bytes"] for r in runs])
    out = {m: float(np.mean([r[m] for r in runs])) for m in METRICS}
    out["parts_p99"] = float(np.mean([r["parts_quantiles"]["0.99"] for r in runs]))
    return out, float(sizes.mean()), float(sizes.std() / sizes.mean())


def main(seeds=range(10)):
    with open("runs/validation_open.json") as f:
        cases = {c: json.load(open(f"runs/validation_{c}.json"))["case"]["model"] for c in CASES}
    rows = []
    for case in CASES:
        target, mean, cv = live(case)
        configs = [calibrated_config(**cases[case], insert_bytes_mean=mean, insert_bytes_cv=cv, assign_latency=l) for l in LATENCIES]
        for latency, (summaries, _) in zip(LATENCIES, stats.replicate_many(configs, 360.0, 90.0, seeds)):
            got = {m: float(np.mean([s[m] for s in summaries])) for m in METRICS}
            got["parts_p99"] = float(np.mean([s["parts_quantiles"][0.99] for s in summaries]))
            rows.append(dict(case=case, latency=latency, model=got, live=target))
            diff = {m: (got[m] / target[m] - 1) * 100 if target[m] else float("nan") for m in got}
            print(f"{case:9} latency {latency * 1000:5.0f} ms: " + ", ".join(f"{m} {d:+.1f}%" for m, d in diff.items()), flush=True)
    with open("runs/open_questions.json", "w") as f:
        json.dump(rows, f, indent=1)


if __name__ == "__main__":
    main()
