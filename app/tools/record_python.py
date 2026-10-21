"""records the python runs diff.test.mjs replays; run from the repo root, calibration.json is read from the cwd"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from calibrate import calibrated_config  # noqa: E402
from inputs import MIB  # noqa: E402
from model import Table  # noqa: E402


class Recorder:
    def __init__(self, rng):
        self.rng = rng
        self.values = []

    def _record(self, name, value, *args):
        self.values.append([name, value, list(args)])
        return value

    def random(self):
        return self._record("random", self.rng.random())

    def expovariate(self, lambd):
        return self._record("expovariate", self.rng.expovariate(lambd), lambd)

    def lognormvariate(self, mu, sigma):
        return self._record("lognormvariate", self.rng.lognormvariate(mu, sigma), mu, sigma)

    def uniform(self, a, b):
        return self._record("uniform", self.rng.uniform(a, b), a, b)


CASES = {
    "normal": (dict(insert_rate=100), 120),
    "saturated": (dict(insert_rate=260), 120),
    "feedback": (dict(arrivals="closed", clients=35, think_time=0.1, parts_to_delay_insert=300, parts_to_throw_insert=900,
                      max_avg_part_size_for_too_many_parts=0), 200),
    "partitions": (dict(insert_rate=150, partition_seconds=60.0, retention_partitions=2, late_insert_fraction=0.1), 300),
    "tiered": (dict(insert_rate=100, selector="tiered"), 120),
    "stf_projection": (dict(insert_rate=40, scheduling_policy="shortest_task_first", threads=4, aux=((0.99, 0.93),)), 200),
    "profile_burst": (dict(insert_rate=150, rate_amplitude=0.5, burst=(60.0, 60.0, 3.0)), 150),
    "rejections": (dict(insert_rate=400, insert_bytes_mean=MIB, threads=1, parts_to_delay_insert=60, parts_to_throw_insert=120), 150),
    "disk_full": (dict(insert_rate=100, disk_bytes=20 * 10**9, old_parts_lifetime=30.0), 150),
    "disk_partitions": (dict(insert_rate=150, partition_seconds=60.0, retention_partitions=2, disk_bytes=60 * 10**9, old_parts_lifetime=20.0), 300),
    # the numpy selector python uses in experiments, and paths the cases above miss
    "fast_selector": (dict(insert_rate=260, selector="simple"), 120),
    "closed_rejections": (dict(arrivals="closed", clients=30, think_time=0.05, insert_bytes_mean=MIB, threads=1, parts_to_delay_insert=40,
                               parts_to_throw_insert=80, max_avg_part_size_for_too_many_parts=0, disk_bytes=3 * 10**9, old_parts_lifetime=5.0), 120),
    "no_merges": (dict(insert_rate=50, max_bytes_at_max_space=0, parts_to_delay_insert=200, parts_to_throw_insert=400, max_parts_in_total=500), 60),
    "retention_one": (dict(insert_rate=40, partition_seconds=20.0, retention_partitions=1, late_insert_fraction=0.3, rate_amplitude=0.5,
                           burst=(30.0, 40.0, 2.5)), 120),
    "large_merges": (dict(insert_rate=150, insert_bytes_mean=8 * MIB, max_parts_to_merge_at_once=0, base=3.0), 200),
}


def record(overrides, until):
    config = calibrated_config(selector=overrides.pop("selector", "simple_reference"), **overrides)
    table = Table(config)
    table.rng = {k: Recorder(v) for k, v in table.rng.items()}
    table.think = [Recorder(t) for t in table.think]
    table.trace = []
    table.start()
    table.engine.run(until)
    plain = {k: (list(map(list, v)) if k == "aux" else list(v) if isinstance(v, tuple) else v) for k, v in config.__dict__.items()}
    return dict(config=plain, until=until, streams={k: r.values for k, r in table.rng.items()}, clients=[r.values for r in table.think],
                trace=table.trace, final=dict(parts=len(table.parts), merges=table.merges_done, delayed=table.delayed, rejected=table.rejected,
                                              rejected_disk=table.rejected_disk, aborted=table.merges_aborted, saved=table.saved_bytes,
                                              inserted=table.inserted_bytes, merged=table.merged_bytes))


if __name__ == "__main__":
    out = {name: record(dict(overrides), until) for name, (overrides, until) in CASES.items()}
    path = os.path.join(os.path.dirname(__file__), "..", "tests", "python_runs.json")
    with open(path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    for name, run in out.items():
        print(name, len(run["trace"]), "events", run["final"])
