// the js model on its own random numbers, unlike the python replay in diff.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Table } from "../src/sim/model.js";
import { CALIBRATED } from "../src/data/calibration.js";

function run(config, until, changes = []) {
  const table = new Table({ ...CALIBRATED, ...config });
  table.start();
  for (const [at, change] of changes) {
    table.engine.run(at, Infinity, () => table.checkInvariants());
    change(table);
  }
  table.engine.run(until, Infinity, () => table.checkInvariants());
  return table;
}

test("invariants hold while every parameter changes on the fly", () => {
  const t = run({ insert_rate: 100 }, 900, [
    [60, tb => tb.configure({ insert_rate: 300 })],
    [120, tb => tb.configure({ threads: 4, scheduling_policy: "shortest_task_first" })],
    [180, tb => tb.configure({ base: 2, max_parts_to_merge_at_once: 20 })],
    [240, tb => tb.configure({ parts_to_delay_insert: 100, parts_to_throw_insert: 200, max_avg_part_size_for_too_many_parts: 0 })],
    [300, tb => tb.burst(3, 30)],
    [360, tb => tb.configure({ partition_seconds: 60, retention_partitions: 3, late_insert_fraction: 0.2 })],
    [420, tb => tb.configure({ aux: [[0.99, 0.93]], selector: "tiered", base: 4 })],
    [480, tb => tb.configure({ arrivals: "closed", clients: 20, think_time: 0.1 })],
    [540, tb => tb.configure({ clients: 5 })],
    [600, tb => tb.setInsertsPaused(true)],
    [660, tb => tb.setInsertsPaused(false)],
    [700, tb => tb.newPartitionNow()],
    [720, tb => tb.dropOldestPartition()],
    [750, tb => tb.configure({ disk_bytes: 3e10, old_parts_lifetime: 60 })],
    [780, tb => tb.configure({ arrivals: "open", insert_rate: 50, partition_seconds: 0, threads: 32, selector: "simple" })],
  ]);
  assert.ok(t.mergesDone > 1000 && t.delayed > 0 && t.droppedPartitions.length > 0 && t.rejectedDisk > 0);
});

function arrivalRate(table, seconds) {
  const before = table.arrivals, from = table.engine.now;
  table.engine.run(from + seconds, Infinity, () => table.checkInvariants());
  return (table.arrivals - before) / seconds;
}

test("closed clients keep one loop each through pauses, client changes and input switches", () => {
  const table = new Table({ ...CALIBRATED, arrivals: "closed", clients: 10, think_time: 0.5 });
  table.start();
  const base = arrivalRate(table, 120);
  assert.ok(Math.abs(base - 20) < 2, `10 clients thinking 0.5 s: ${base}/s`);
  for (let i = 0; i < 3; i++) { table.setInsertsPaused(true); table.setInsertsPaused(false); }  // at the same model time
  assert.ok(Math.abs(arrivalRate(table, 120) - base) < 0.15 * base, "pause and resume do not add loops");
  table.configure({ clients: 1 });
  table.configure({ clients: 10 });
  assert.ok(Math.abs(arrivalRate(table, 120) - base) < 0.15 * base, "removing and adding clients does not add loops");
  table.configure({ arrivals: "open", insert_rate: 5 });
  arrivalRate(table, 5);  // pending client events end their loops
  assert.ok(Math.abs(arrivalRate(table, 120) - 5) < 1, "after the switch to open only the open input arrives");
  table.configure({ arrivals: "closed" });
  assert.ok(Math.abs(arrivalRate(table, 120) - base) < 0.15 * base, "back to closed: one loop per client");
});

test("turning partitions off sends new inserts to the newest partition", () => {
  const table = run({ insert_rate: 100, partition_seconds: 60, retention_partitions: 3 }, 200);
  table.configure({ partition_seconds: 0 });
  table.engine.run(260, Infinity, () => table.checkInvariants());
  const keys = [...table.partitions.keys()];
  const newest = table.partitions.get(keys[keys.length - 1]);
  assert.ok(keys[keys.length - 1] === table.currentPartition && newest.some(p => p.createdAt > 200), JSON.stringify(keys));
});

test("a burst adds arrivals without moving the base ones", () => {
  const times = burst => {
    const table = new Table({ ...CALIBRATED, insert_rate: 50, seed: 3 });
    const out = [];
    table.observer = (type, t, delay, size, client) => { if (type === "arrival") out.push(t); };
    table.start();
    table.engine.run(30);
    if (burst) table.burst(3, 30);
    table.engine.run(120);
    return out;
  };
  const base = times(false), withBurst = new Set(times(true));
  assert.ok(base.every(t => withBurst.has(t)) && withBurst.size > base.length * 1.4, `${base.length} and ${withBurst.size}`);
});

test("pausing inserts stops them, resuming starts them again", () => {
  const table = new Table({ ...CALIBRATED, insert_rate: 100 });
  table.start();
  table.engine.run(60);
  table.setInsertsPaused(true);
  const paused = table.lastBlock + table.inFlight;
  table.engine.run(300, Infinity, () => table.checkInvariants());
  assert.equal(table.lastBlock, paused);
  table.setInsertsPaused(false);
  table.engine.run(360);
  assert.ok(table.lastBlock > paused + 4000);
});

test("statistics agree with the Python experiment E1", () => {
  const e1 = JSON.parse(readFileSync(new URL("../../results/e1_load.json", import.meta.url)));
  const i = e1.rates.indexOf(150);
  const [pythonMean, pythonHalf] = e1.runs[i].stats.parts_mean;
  const means = [];
  for (let seed = 1; seed <= 4; seed++) {
    const table = new Table({ ...CALIBRATED, insert_rate: 150, seed });
    table.start();
    table.engine.run(600);
    let area = 0, last = table.engine.now, count = table.partCount;
    table.observer = () => { area += count * (table.engine.now - last); last = table.engine.now; count = table.partCount; };
    table.engine.run(3600);
    area += count * (3600 - last);
    means.push(area / 3000);
  }
  const mean = means.reduce((a, b) => a + b) / means.length;
  assert.ok(Math.abs(mean - pythonMean) < 0.03 * pythonMean, `JavaScript ${mean}, Python ${pythonMean} ± ${pythonHalf}`);
});
