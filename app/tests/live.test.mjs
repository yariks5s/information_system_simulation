// The JavaScript model with its own random numbers: invariants under live parameter changes, and statistics
// close to the Python experiments (results/e1_load.json).
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
    [780, tb => tb.configure({ arrivals: "open", insert_rate: 50, partition_seconds: 0, threads: 32, selector: "simple" })],
  ]);
  assert.ok(t.mergesDone > 1000 && t.delayed > 0 && t.droppedPartitions.length > 0);
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
  assert.ok(Math.abs(mean - pythonMean) < 0.06 * pythonMean, `JavaScript ${mean}, Python ${pythonMean} ± ${pythonHalf}`);
});
