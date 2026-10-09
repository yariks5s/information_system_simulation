// MergeTree background merges: state and event handlers, a port of model.py (RFC sections 3 and 5).
// The same event order and the same draws from the same streams, so that with recorded random numbers it
// reproduces the Python model event by event (tests/diff.test.mjs). On top of that: parameters can change while
// the model runs, and an observer sees every event.

import { Engine } from "./engine.js";
import { Pool } from "./pool.js";
import { lognormal, roundHalfEven, streams, Rng } from "./rng.js";
import { maxSourcePartsBytes, selectAcross } from "./selector.js";
import { checkInsert } from "./throttle.js";

const MIB = 1024 * 1024;
const DAY = 86400;

export const DEFAULTS = {
  // input (RFC 3.2, 3.8)
  arrivals: "open",
  insert_rate: 2.0,
  rate_amplitude: 0.0,
  rate_peak_at: 14 * 3600,
  burst: null,  // [start, duration, factor]
  clients: 4,
  think_time: 2.0,
  insert_bytes_mean: 10 * MIB,
  insert_bytes_cv: 1.0,
  // throttling (RFC 3.3)
  parts_to_delay_insert: 1000,
  max_delay_to_insert: 1,
  min_delay_to_insert_ms: 10,
  max_avg_part_size_for_too_many_parts: 1024 * MIB,
  max_parts_in_total: 100000,
  // pool
  threads: 16,
  concurrency_ratio: 2,
  scheduling_policy: "round_robin",
  // selector
  selector: "simple",
  base: 5.0,
  window_size: 1000,
  max_parts_to_merge_at_once: 100,
  lower_max_parts_exponent: 5,
  parts_to_throw_insert: 3000,
  max_bytes_at_max_space: 150 * 1024 * MIB,
  max_bytes_at_min_space: MIB,
  free_entries_to_lower_max_size: 8,
  // merge cost
  merge_fixed_seconds: 0.05,
  merge_bytes_per_second: 150e6,
  merge_noise_cv: 0.3,
  aux: [],  // [storage overhead s, merge time overhead δ] per projection or skip index
  // partitions (RFC 3.9)
  partition_seconds: 0.0,
  late_insert_fraction: 0.0,
  retention_partitions: 0,
  seed: 1,
};

export class Table {
  // rng: optional { streams, client(c) } to replace the random streams, used by the differential test
  constructor(config = {}, rng = null) {
    this.cfg = { ...DEFAULTS, ...config };
    const cfg = this.cfg;
    if (!["open", "closed"].includes(cfg.arrivals)) throw new Error(`unknown arrivals ${cfg.arrivals}`);
    if (!["simple", "simple_reference", "tiered"].includes(cfg.selector)) throw new Error(`unknown selector ${cfg.selector}`);
    this.engine = new Engine();
    this.rngSource = rng;
    this.rng = rng ? rng.streams : streams(cfg.seed, "arrival", "thinning", "size", "merge", "assignee", "partition");
    this.think = [];
    for (let c = 0; c < cfg.clients; c++) this.think.push(this.clientRng(c));
    this.pool = new Pool(this.engine, cfg.threads, cfg.threads * cfg.concurrency_ratio, cfg.scheduling_policy, task => this.onMergeDone(task));
    this.partitions = new Map([[0, []]]);  // key -> active parts ordered by block number, keys ascending
    this.partitionBytes = new Map([[0, 0]]);
    this.partCount = 0;
    this.currentPartition = 0;
    this.pendingDrops = new Set();
    this.droppedPartitions = [];
    this.nextId = 1;
    this.lastBlock = 0;
    this.insertedBytes = 0;
    this.droppedBytes = 0;
    this.droppedBlocks = 0;
    this.arrivals = 0;
    this.inFlight = 0;
    this.rejected = 0;
    this.delayed = 0;
    this.delayTotalMs = 0;
    this.mergedBytes = 0;
    this.mergesDone = 0;
    this.selectorRuns = 0;
    this.noWorkCount = 0;
    this.assigneeAt = Infinity;
    this.assigneeToken = 0;
    this.arrivalToken = 0;
    this.rotationToken = 0;
    this.activeClients = cfg.clients;
    this.insertsPaused = false;
    this.lastSelection = null;  // the outcome of the last selector run, for the UI
    this.lastMerge = null;  // why the last merge was chosen
    this.observer = null;  // (type, ...data) on every event, see emit
    this.updateDerived();
  }

  clientRng(c) {
    return this.rngSource ? this.rngSource.client(c) : new Rng(`${this.cfg.seed}:think:${c}`);
  }

  updateDerived() {
    const cfg = this.cfg;
    this.auxStorage = 1 + cfg.aux.reduce((s, a) => s + a[0], 0);
    this.auxTime = 1 + cfg.aux.reduce((s, a) => s + a[1], 0);
    const peakFactor = Math.max(1.0, cfg.burst ? cfg.burst[2] : 1.0);
    this.peakRate = cfg.insert_rate * (1 + cfg.rate_amplitude) * peakFactor;
  }

  rate(t) {
    const cfg = this.cfg;
    let value = cfg.insert_rate * (1 + cfg.rate_amplitude * Math.cos(2 * Math.PI * (t - cfg.rate_peak_at) / DAY));
    const b = cfg.burst;
    if (b && b[0] <= t && t < b[0] + b[1]) value *= b[2];
    return value;
  }

  emit(type, ...data) {
    if (this.observer) this.observer(type, this.engine.now, ...data);
  }

  get parts() {
    const out = [];
    for (const parts of this.partitions.values()) out.push(...parts);
    return out;
  }

  start() {
    if (this.cfg.partition_seconds) this.scheduleRotation();
    if (this.cfg.arrivals === "open") this.scheduleArrival();
    else for (let c = 0; c < this.cfg.clients; c++) this.thinkThen(c);
    this.trigger();
  }

  // inputs

  scheduleArrival() {
    // a non-homogeneous Poisson process by thinning (Lewis, Shedler)
    if (this.insertsPaused || this.cfg.insert_rate <= 0) return;
    let t = this.engine.now;
    for (;;) {
      t += this.rng.arrival.expovariate(this.peakRate);
      if (this.rng.thinning.random() * this.peakRate <= this.rate(t)) break;
    }
    this.engine.schedule(t - this.engine.now, token => { if (token === this.arrivalToken) this.onInsertArrival(null); }, this.arrivalToken);
  }

  thinkThen(client) {
    this.engine.schedule(this.think[client].expovariate(1 / this.cfg.think_time), c => this.onInsertArrival(c), client);
  }

  onInsertArrival(client) {
    if (client === null) this.scheduleArrival();
    else if (client >= this.activeClients || this.insertsPaused) return;  // the client was removed or inserts are paused
    this.arrivals++;
    // drawn before the throttling decision, so that the i-th insert has the same size in every configuration
    const size = Math.max(1, roundHalfEven(lognormal(this.rng.size, this.cfg.insert_bytes_mean, this.cfg.insert_bytes_cv) * this.auxStorage));
    let key = null, most = -1;
    for (const [k, parts] of this.partitions) if (parts.length >= most) { most = parts.length; key = k; }
    const delay = checkInsert(this.partitions.get(key).length, this.partitionBytes.get(key), this.cfg, this.partCount);
    this.emit("arrival", delay, size, client);
    if (delay === null) {
      this.rejected++;
      if (client !== null) this.thinkThen(client);
      return;
    }
    if (delay) {
      this.delayed++;
      this.delayTotalMs += delay;
    }
    this.inFlight++;
    this.engine.schedule(delay / 1000, (s, c) => this.onInsertCommit(s, c), size, client);
  }

  partitionForInsert() {
    if (!this.cfg.partition_seconds) return 0;
    const key = this.currentPartition;
    if (this.cfg.late_insert_fraction && this.rng.partition.random() < this.cfg.late_insert_fraction) {
      if (this.partitions.has(key - 1) && !this.pendingDrops.has(key - 1)) return key - 1;
    }
    return key;
  }

  onInsertCommit(size, client) {
    this.inFlight--;
    this.lastBlock++;
    const key = this.partitionForInsert();
    if (!this.partitions.has(key)) this.addPartition(key);
    const part = { id: this.nextId++, minBlock: this.lastBlock, maxBlock: this.lastBlock, level: 0, size, createdAt: this.engine.now,
                   partition: key, blocks: 1, merging: false, pickedAt: null, removedAt: null, dropped: false, origin: null };
    this.partitions.get(key).push(part);
    this.partitionBytes.set(key, this.partitionBytes.get(key) + size);
    this.partCount++;
    this.insertedBytes += size;
    this.emit("insert", part);
    this.trigger();  // MergeTreeSink wakes the assignee after every insert
    if (client !== null) this.thinkThen(client);
  }

  addPartition(key) {
    // keys stay ascending: a new key is the largest one, a late insert goes to an existing key
    const entries = [...this.partitions.entries(), [key, []]].sort((a, b) => a[0] - b[0]);
    this.partitions = new Map(entries);
    this.partitionBytes.set(key, 0);
  }

  // assignee

  trigger() {
    this.noWorkCount = Math.floor(this.noWorkCount / 2);
    if (this.assigneeAt > this.engine.now) this.scheduleAssignee(0.0);
  }

  postpone() {
    this.noWorkCount++;
    const delay = Math.min(600.0, 0.1 * Math.pow(1.1, this.noWorkCount)) + this.rng.assignee.uniform(0, 1);
    this.scheduleAssignee(delay);
    this.emit("sleep", delay);
  }

  scheduleAssignee(delay) {
    this.assigneeToken++;
    this.assigneeAt = this.engine.now + delay;
    this.engine.schedule(delay, token => this.onAssigneeRun(token), this.assigneeToken);
  }

  onAssigneeRun(token) {
    if (token !== this.assigneeToken) return;
    this.assigneeAt = Infinity;
    if (this.tryAssignMerge()) this.trigger();
    else this.postpone();
  }

  tryAssignMerge() {
    // a full pool rejects the task, so the selection would be discarded anyway
    if (!this.pool.hasCapacity()) {
      this.lastSelection = { at: this.engine.now, outcome: "pool_full" };
      return false;
    }
    this.selectorRuns++;
    const maxBytes = maxSourcePartsBytes(this.pool.maxTasks, this.pool.tasks.length, this.cfg);
    if (maxBytes === 0) {
      this.lastSelection = { at: this.engine.now, outcome: "disabled" };
      return false;
    }
    const stats = { considered: 0, allowed: 0 };
    const found = selectAcross(this.partitions, this.engine.now, maxBytes, this.cfg, this.cfg.selector, stats);
    if (found === null) {
      this.lastSelection = { at: this.engine.now, outcome: "nothing", maxBytes, ...stats };
      return false;
    }
    const sources = this.partitions.get(found.key).slice(found.begin, found.end);
    let size = 0;
    for (const p of sources) {
      p.merging = true;
      p.pickedAt = this.engine.now;
      size += p.size;
    }
    const noise = lognormal(this.rng.merge, 1.0, this.cfg.merge_noise_cv);
    const baseSize = size / this.auxStorage;
    const work = (this.cfg.merge_fixed_seconds + baseSize / this.cfg.merge_bytes_per_second) * noise * this.auxTime;
    const task = { id: this.nextId++, work, priority: size, payload: sources, remaining: 0, rate: 0, createdAt: 0 };
    this.pool.add(task);
    this.lastSelection = this.lastMerge = { at: this.engine.now, outcome: "merge", task: task.id, maxBytes,
                                            freeEntries: this.pool.maxTasks - this.pool.tasks.length + 1, ...stats, ...found, work };
    this.emit("assign", task, found);
    return true;
  }

  // merges

  onMergeDone(task) {
    const sources = task.payload;
    const key = sources[0].partition;
    const parts = this.partitions.get(key);
    const begin = parts.indexOf(sources[0]);
    let level = 0, blocks = 0;
    for (const p of sources) { if (p.level > level) level = p.level; blocks += p.blocks; }
    level += 1;
    const merged = { id: task.id, minBlock: sources[0].minBlock, maxBlock: sources[sources.length - 1].maxBlock, level, size: task.priority,
                     createdAt: this.engine.now, partition: key, blocks, merging: false, pickedAt: null, removedAt: null, dropped: false,
                     origin: { sources: sources.length, levels: sources.map(p => p.level), assignedAt: task.createdAt, work: task.work } };
    parts.splice(begin, sources.length, merged);
    this.partCount -= sources.length - 1;
    for (const p of sources) p.removedAt = this.engine.now;
    this.mergedBytes += task.priority;
    this.mergesDone++;
    this.emit("merged", task, merged);
    if (this.pendingDrops.has(key)) this.tryDrop(key);
  }

  // partitions

  scheduleRotation() {
    this.rotationToken++;
    this.engine.schedule(this.cfg.partition_seconds, token => { if (token === this.rotationToken) this.onPartitionRotate(); }, this.rotationToken);
  }

  onPartitionRotate() {
    this.scheduleRotation();
    this.currentPartition++;
    this.emit("rotate", this.currentPartition);
    if (this.cfg.retention_partitions) this.applyRetention();
  }

  applyRetention() {
    for (const key of [...this.partitions.keys()]) {
      if (key <= this.currentPartition - this.cfg.retention_partitions) {
        this.pendingDrops.add(key);
        this.tryDrop(key);
      }
    }
  }

  tryDrop(key) {
    // DROP PARTITION, once no merge of this partition is running
    const parts = this.partitions.get(key);
    if (!parts || parts.some(p => p.merging)) return false;
    for (const p of parts) {
      p.removedAt = this.engine.now;
      p.dropped = true;
      this.droppedBytes += p.size;
      this.droppedBlocks += p.blocks;
    }
    this.partCount -= parts.length;
    this.partitions.delete(key);
    this.partitionBytes.delete(key);
    if (!this.partitions.size) this.addPartition(key + 1);
    this.pendingDrops.delete(key);
    this.droppedPartitions.push([key, this.engine.now]);
    this.emit("drop", key, parts.length);
    return true;
  }

  // live changes from the UI; each takes effect from the current model time

  configure(changes) {
    const cfg = this.cfg, old = { ...cfg };
    Object.assign(cfg, changes);
    this.updateDerived();
    if (["insert_rate", "rate_amplitude", "burst"].some(k => k in changes) && cfg.arrivals === "open") this.restartArrivals();
    if ("arrivals" in changes && changes.arrivals !== old.arrivals) {
      this.arrivalToken++;
      if (cfg.arrivals === "open") this.scheduleArrival();
      else for (let c = 0; c < this.activeClients; c++) this.thinkThen(c);
    }
    if ("clients" in changes) this.setClients(cfg.clients);
    if (["threads", "concurrency_ratio", "scheduling_policy"].some(k => k in changes)) {
      this.pool.configure({ threads: cfg.threads, maxTasks: cfg.threads * cfg.concurrency_ratio, policy: cfg.scheduling_policy });
    }
    if ("partition_seconds" in changes && changes.partition_seconds !== old.partition_seconds) {
      this.rotationToken++;
      if (cfg.partition_seconds) this.scheduleRotation();
    }
    if ("retention_partitions" in changes && cfg.retention_partitions) this.applyRetention();
    this.trigger();  // new selector settings may allow a merge right away
  }

  restartArrivals() {
    this.arrivalToken++;
    this.scheduleArrival();
  }

  setClients(n) {
    const before = this.activeClients;
    while (this.think.length < n) this.think.push(this.clientRng(this.think.length));
    this.activeClients = n;
    if (this.cfg.arrivals === "closed" && !this.insertsPaused) for (let c = before; c < n; c++) this.thinkThen(c);
  }

  setInsertsPaused(paused) {
    if (paused === this.insertsPaused) return;
    this.insertsPaused = paused;
    if (paused) { this.arrivalToken++; return; }
    if (this.cfg.arrivals === "open") this.restartArrivals();
    else for (let c = 0; c < this.activeClients; c++) this.thinkThen(c);
  }

  burst(factor, duration) {
    this.configure({ burst: [this.engine.now, duration, factor] });
  }

  newPartitionNow() {
    if (!this.cfg.partition_seconds) return;
    this.rotationToken++;
    this.onPartitionRotate();
  }

  dropOldestPartition() {
    const keys = [...this.partitions.keys()];
    if (keys.length < 2) return false;
    this.pendingDrops.add(keys[0]);
    return this.tryDrop(keys[0]);
  }

  // checks of RFC section 7
  checkInvariants() {
    const parts = this.parts;
    let size = 0, blocks = 0, merging = 0;
    for (const p of parts) { size += p.size; blocks += p.blocks; if (p.merging) merging++; }
    assert(size === this.insertedBytes - this.droppedBytes, "byte balance");
    assert(blocks === this.lastBlock - this.droppedBlocks, "block balance");
    assert(parts.length === this.partCount, "part count");
    let prevKey = -Infinity;
    for (const [key, ps] of this.partitions) {
      assert(key > prevKey, "partition keys ascending");
      prevKey = key;
      let bytes = 0;
      ps.forEach((p, i) => {
        bytes += p.size;
        assert(p.partition === key && p.maxBlock >= p.minBlock && !p.dropped, "part fields");
        if (i) assert(ps[i - 1].maxBlock < p.minBlock, "parts ordered and disjoint");
      });
      assert(bytes === this.partitionBytes.get(key), "partition bytes");
    }
    // the pool size is not checked: a pool shrunk from the UI keeps its running tasks, and Pool.add refuses new ones
    assert(this.pool.busyThreads() <= this.pool.threads + 1e-9, "busy threads");
    let sources = 0;
    for (const t of this.pool.tasks) {
      const ps = this.partitions.get(t.payload[0].partition);
      const first = ps.indexOf(t.payload[0]);
      t.payload.forEach((p, j) => assert(p.merging && ps[first + j] === p, "sources adjacent"));
      sources += t.payload.length;
    }
    assert(sources === merging, "merging flags");
  }
}

function assert(condition, message) {
  if (!condition) throw new Error("invariant: " + message);
}
