// Time series of a running model: one sample per second of model time, from an engine event that draws no
// random numbers, so sampling does not change the model's trajectory.

import { maxSourcePartsBytes } from "../sim/selector.js";

export class Sampler {
  constructor(table, capacity = 7200) {
    this.table = table;
    this.capacity = capacity;
    this.samples = [];
    this.counts = { accepted: 0, delayed: 0, rejected: 0, nospace: 0, maxDelay: 0, mergeTime: 0, merges: 0 };
    this.prevInserted = 0;
    this.prevMerged = 0;
    table.engine.schedule(1, () => this.sample());
  }

  // called by the lab for every model event; a delayed insert counts as delayed when it commits, so an insert that
  // waits out its delay and then gets NOT_ENOUGH_SPACE counts only as rejected
  observe(type, t, ...data) {
    const c = this.counts;
    if (type === "arrival") {
      if (data[0] === null) c.rejected++;
    } else if (type === "insert") {
      c.accepted++;
      const delay = data[1];
      if (delay > 0) { c.delayed++; c.maxDelay = Math.max(c.maxDelay, delay); }
    } else if (type === "nospace") c.nospace++;
    else if (type === "merged") { c.merges++; c.mergeTime += t - data[0].createdAt; }
  }

  sample() {
    const tb = this.table;
    tb.engine.schedule(1, () => this.sample());
    let largest = 0, fresh = 0, maxLevel = 0;
    for (const parts of tb.partitions.values()) {
      if (parts.length > largest) largest = parts.length;
      for (const p of parts) { if (p.level === 0) fresh++; if (p.level > maxLevel) maxLevel = p.level; }
    }
    const c = this.counts, cfg = tb.cfg;
    const used = tb.diskUsed();
    const free = cfg.disk_bytes ? Math.max(0, cfg.disk_bytes - used) : null;
    const s = {
      t: tb.engine.now, parts: tb.partCount, largest, fresh, maxLevel, partitions: tb.partitions.size,
      busy: tb.pool.busyThreads(), tasks: tb.pool.tasks.length, threads: tb.pool.threads,
      accepted: c.accepted, delayed: c.delayed, rejected: c.rejected, nospace: c.nospace, maxDelay: c.maxDelay,
      used, outdated: tb.outdatedBytes, diskLimit: cfg.disk_bytes,
      cap: maxSourcePartsBytes(tb.pool.maxTasks, tb.pool.tasks.length, cfg, free),
      inserted: tb.insertedBytes - this.prevInserted, merged: tb.mergedBytes - this.prevMerged,
      merges: c.merges, mergeTime: c.mergeTime,
    };
    this.prevInserted = tb.insertedBytes;
    this.prevMerged = tb.mergedBytes;
    this.counts = { accepted: 0, delayed: 0, rejected: 0, nospace: 0, maxDelay: 0, mergeTime: 0, merges: 0 };
    this.samples.push(s);
    if (this.samples.length > this.capacity) this.samples.shift();
  }

  // the last `seconds` samples
  window(seconds) {
    const n = this.samples.length;
    if (!n) return [];
    const from = this.samples[n - 1].t - seconds;
    let i = n - 1;
    while (i > 0 && this.samples[i - 1].t > from) i--;
    return this.samples.slice(i);
  }

  // sums over the last `seconds` of model time
  totals(seconds) {
    const out = { accepted: 0, delayed: 0, rejected: 0, nospace: 0, inserted: 0, merged: 0, merges: 0, mergeTime: 0, span: 0 };
    for (const s of this.window(seconds)) {
      for (const k of ["accepted", "delayed", "rejected", "nospace", "inserted", "merged", "merges", "mergeTime"]) out[k] += s[k];
      out.span++;
    }
    return out;
  }
}
