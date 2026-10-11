"""Open questions of the validation (RFC section 8): does a delay between a trigger and the assignee run explain the
gaps, and how much of the delayed-insert gap can the way the server counts delays explain? On the server a query counts
as delayed if any of its parallel sinks slept, and a sink that starts late can see the part of its own query; the model
checks once, without that part.

    python3 open_questions.py   (no server needed: compares with the stored live runs)"""
import json
from dataclasses import replace

import numpy as np

import model
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
    own = own_part_bounds(cases["throttled"], seeds)
    print(f"throttled: delayed without the own part {own['without']:.1%}, with it {own['with']:.1%}, "
          f"live {live('throttled')[0]['delayed_fraction']:.1%}")
    with open("runs/open_questions.json", "w") as f:
        json.dump(dict(latency=rows, own_part=own), f, indent=1)


def _own_part_job(job):
    config, threshold = job
    table = model.Table(config)
    table.start()
    table.engine.run(360.0)
    changes = sorted(stats.parts_changes(table))
    times, counts = np.array([c[0] for c in changes]), np.cumsum([c[1] for c in changes])
    accepted = [t for t, delay in table.history_inserts if 90 <= t <= 360 and delay is not None]
    before = np.array([counts[np.searchsorted(times, t, side="left") - 1] for t in accepted])
    return float((before >= threshold).mean()), float((before + 1 >= threshold).mean())


def own_part_bounds(case_model, seeds):
    """Share of accepted inserts that find the partition at parts_to_delay_insert, without and with their own part."""
    target, mean, cv = live("throttled")
    config = calibrated_config(**case_model, insert_bytes_mean=mean, insert_bytes_cv=cv)
    shares = np.array(stats.pmap(_own_part_job, [(replace(config, seed=s), config.parts_to_delay_insert) for s in seeds]))
    return {"without": float(shares[:, 0].mean()), "with": float(shares[:, 1].mean())}


if __name__ == "__main__":
    main()
