// Differential test: the JavaScript model, fed the random numbers the Python model drew, must produce the same
// trace event by event. Regenerate the Python runs with app/tools/record_python.py.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Table } from "../src/sim/model.js";

const runs = JSON.parse(readFileSync(new URL("./python_runs.json", import.meta.url)));

class Replay {
  constructor(values, name) { this.values = values; this.i = 0; this.name = name; }
  take(kind) {
    assert.ok(this.i < this.values.length, `${this.name}: out of recorded numbers`);
    const [k, v] = this.values[this.i++];
    assert.equal(k, kind, `${this.name}: draw ${this.i} is ${k} in Python, ${kind} in JavaScript`);
    return v;
  }
  random() { return this.take("random"); }
  expovariate() { return this.take("expovariate"); }
  lognormvariate() { return this.take("lognormvariate"); }
  uniform() { return this.take("uniform"); }
}

function close(a, b) {
  return a === b || Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

for (const [name, run] of Object.entries(runs)) {
  test(`trace matches Python: ${name}`, () => {
    const streams = Object.fromEntries(Object.entries(run.streams).map(([k, v]) => [k, new Replay(v, k)]));
    const table = new Table(run.config, { streams, client: c => new Replay(run.clients[c], `think:${c}`) });
    const trace = [];
    table.observer = (type, t, ...data) => {
      if (type === "arrival") trace.push(["arrival", t, data[0]]);
      else if (type === "insert") trace.push(["insert", t, data[0].id, data[0].partition, data[0].size, data[0].minBlock]);
      else if (type === "assign") trace.push(["assign", t, data[0].id, data[1].key, data[1].begin, data[1].end - data[1].begin, data[0].work]);
      else if (type === "merged") trace.push(["merged", t, data[0].id, data[1].level]);
      else if (type === "drop") trace.push(["drop", t, data[0]]);
      else if (type === "nospace") trace.push(["nospace", t, data[0]]);
    };
    table.start();
    table.engine.run(run.until, Infinity, () => {});
    const expected = run.trace;
    const n = Math.min(trace.length, expected.length);
    for (let i = 0; i < n; i++) {
      const a = trace[i], b = expected[i];
      const same = a.length === b.length && a.every((v, j) => (typeof v === "number" && typeof b[j] === "number" ? close(v, b[j]) : v === b[j]));
      assert.ok(same, `${name}: event ${i} differs\n  JavaScript ${JSON.stringify(a)}\n  Python     ${JSON.stringify(b)}`);
    }
    assert.equal(trace.length, expected.length, `${name}: number of events`);
    assert.equal(table.parts.length, run.final.parts);
    assert.equal(table.mergesDone, run.final.merges);
    assert.equal(table.delayed, run.final.delayed);
    assert.equal(table.rejected, run.final.rejected);
    assert.equal(table.rejectedDisk, run.final.rejected_disk);
    assert.equal(table.insertedBytes, run.final.inserted);
    assert.equal(table.mergedBytes, run.final.merged);
    table.checkInvariants();
  });
}
