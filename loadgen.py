"""Load generator for the live server (RFC section 8): an open or closed insert stream into a
MergeTree table, and a monitor that samples active parts and throttling counters every second."""
import argparse
import csv
import json
import os
import random
import re
import shutil
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

URL = os.environ.get("SIM_CLICKHOUSE_URL", "http://127.0.0.1:19481/")
TOO_MANY_PARTS = 252
DATA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "server", "data")
MIN_FREE_BYTES = 20 * 2**30  # the disk is shared with other work on this machine
EVENTS = ("DelayedInserts", "RejectedInserts", "DelayedInsertsMilliseconds")


class ServerError(Exception):
    @property
    def code(self):
        match = re.search(r"Code: (\d+)", str(self))
        return int(match.group(1)) if match else None


def query(sql):
    request = urllib.request.Request(URL, data=sql.encode())
    try:
        with urllib.request.urlopen(request, timeout=600) as response:
            return response.read().decode()
    except urllib.error.HTTPError as error:
        raise ServerError(error.read().decode()) from None


def create_table(table, extra="", settings=""):
    """extra: projections and indices; settings: more MergeTree settings, e.g. throttling thresholds."""
    query(f"DROP TABLE IF EXISTS {table} SYNC")
    query(f"""CREATE TABLE {table} (
        ts DateTime, user_id UInt64, event LowCardinality(String), url String, value Float64, payload String{extra})
        ENGINE = MergeTree ORDER BY (user_id, ts)
        SETTINGS old_parts_lifetime = 10{", " + settings if settings else ""}""")  # outdated parts would otherwise hold the disk for 8 minutes


def insert_sql(table, rows, async_insert=False):
    # generated on the server in one block; async_insert is on by default since 26.2 and batches
    # several inserts into one part, so it is set explicitly
    return f"""INSERT INTO {table} SETTINGS async_insert = {int(async_insert)} SELECT now() - rand() % 86400, rand64() % 1000000,
        ['view', 'click', 'buy', 'scroll'][rand() % 4 + 1], concat('https://example.com/', toString(rand() % 100000)),
        rand() / 1e9, randomPrintableASCII(100) FROM numbers({rows})"""


def sample(table):
    db, name = table.split(".")
    parts, size = query(f"SELECT count(), sum(bytes_on_disk) FROM system.parts WHERE database = '{db}' AND table = '{name}' AND active").split()
    tasks = query("SELECT value FROM system.metrics WHERE metric = 'BackgroundMergesAndMutationsPoolTask'").strip()
    counters = dict(line.split("\t") for line in query(
        f"SELECT event, value FROM system.events WHERE event IN {EVENTS!r}").splitlines())
    return int(parts), int(size or 0), int(tasks), {e: int(counters.get(e, 0)) for e in EVENTS}


def run(table, out_dir, duration, rows, mode="open", rate=1.0, clients=4, think=1.0, seed=1, extra="", settings="", async_insert=False):
    """Returns the output directory with inserts.csv, monitor.csv and meta.json."""
    os.makedirs(out_dir, exist_ok=True)
    create_table(table, extra, settings)
    rng = random.Random(seed)
    sql = insert_sql(table, rows, async_insert)
    records, lock, failures = [], threading.Lock(), []
    _, _, _, base = sample(table)
    t0 = time.monotonic()
    stop = t0 + duration
    abort = threading.Event()

    def insert(arrival):
        try:
            query(sql)
            status = "ok"
        except ServerError as error:
            if error.code != TOO_MANY_PARTS:
                failures.append(error)
                raise
            status = "rejected"
        with lock:
            records.append((arrival - t0, time.monotonic() - t0, status))

    monitor = []

    def watch():
        while time.monotonic() < stop and not abort.is_set():
            if shutil.disk_usage(DATA_PATH).free < MIN_FREE_BYTES:
                failures.append(RuntimeError("less than 20 GiB free on disk, run aborted"))
                abort.set()
                return
            parts, size, tasks, counters = sample(table)
            monitor.append((time.monotonic() - t0, parts, size, tasks, *(counters[e] - base[e] for e in EVENTS)))
            time.sleep(1.0)

    watcher = threading.Thread(target=watch)
    watcher.start()
    if mode == "open":
        with ThreadPoolExecutor(max_workers=256) as pool:
            futures, at = [], t0
            while True:
                at += rng.expovariate(rate)
                if at >= stop or abort.is_set():
                    break
                time.sleep(max(0.0, at - time.monotonic()))
                futures.append(pool.submit(insert, at))
            for future in futures:
                future.result()
    else:
        def client(c):
            local = random.Random(f"{seed}:{c}")
            while True:
                time.sleep(local.expovariate(1 / think))
                if time.monotonic() >= stop or abort.is_set():
                    return
                insert(time.monotonic())

        threads = [threading.Thread(target=client, args=(c,)) for c in range(clients)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
    watcher.join()
    if failures:
        raise failures[0]
    query("SYSTEM FLUSH LOGS")
    with open(f"{out_dir}/inserts.csv", "w", newline="") as f:
        csv.writer(f).writerows([("arrival", "finished", "status"), *sorted(records)])
    with open(f"{out_dir}/monitor.csv", "w", newline="") as f:
        csv.writer(f).writerows([("time", "parts", "bytes", "pool_tasks", *EVENTS), *monitor])
    with open(f"{out_dir}/meta.json", "w") as f:
        json.dump(dict(table=table, duration=duration, rows=rows, mode=mode, rate=rate, clients=clients,
                       think=think, seed=seed, extra=extra, settings=settings, async_insert=async_insert), f, indent=1)
    return out_dir


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("out_dir")
    parser.add_argument("--table", default="default.events")
    parser.add_argument("--duration", type=float, default=60)
    parser.add_argument("--rows", type=int, default=100000)
    parser.add_argument("--mode", choices=("open", "closed"), default="open")
    parser.add_argument("--rate", type=float, default=1.0)
    parser.add_argument("--clients", type=int, default=4)
    parser.add_argument("--think", type=float, default=1.0)
    parser.add_argument("--seed", type=int, default=1)
    args = parser.parse_args()
    print(run(args.table, args.out_dir, args.duration, args.rows, args.mode, args.rate, args.clients, args.think, args.seed))
