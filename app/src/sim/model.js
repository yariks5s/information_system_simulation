// MergeTree background merges: state and event handlers, a port of model.py (RFC sections 3 and 5).
// The same event order and the same draws from the same streams, so that with recorded random numbers it
// reproduces the Python model event by event (tests/diff.test.mjs). On top of that: parameters can change while
// the model runs, and an observer sees every event.

import { Engine } from "./engine.js";
import { Pool } from "./pool.js";
import { lognormal, roundHalfEven, streams, Rng } from "./rng.js";
import { RESERVE_RATIO, maxSourcePartsBytes, selectAcross } from "./selector.js";
import { checkInsert } from "./throttle.js";

const MIB = 1024 * 1024;
const DAY = 86400;

export const DEFAULTS = {
  // input (RFC 3.2, 3.8)
  arrivals: "open",
  insert_rate: 2.0,
  rate_amplitude: 0.0,
  rate_peak_at: 14 * 3600,
  burst: null,  // [start, duration, factor], factor > 1: a separate Poisson process on top (RFC 3.2)
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
  // size of a merged part (RFC 3.1): result_ratio of the sources, result_ratio_large once per byte in merges of at
  // least large_merge_bytes (0: no such regime), which also take large_merge_time_factor longer (RFC 3.7)
  result_ratio: 1.0,
  result_ratio_large: 1.0,
  large_merge_bytes: 0,
  large_merge_time_factor: 1.0,
  // partitions (RFC 3.9)
  partition_seconds: 0.0,
  late_insert_fraction: 0.0,
  retention_partitions: 0,
  // seconds between a trigger and the assignee run
  assign_latency: 0.0,
  // disk (RFC 3.10): bytes the table may take (0: no limit), and how long merged parts stay on disk
  disk_bytes: 0,
  old_parts_lifetime: 480.0,
  seed: 1,
};

const STREAMS = ["arrival", "thinning", "size", "merge", "assignee", "partition", "burst_arrival", "burst_thinning", "burst_size", "burst_partition"];

export class Table {
  // rng: optional { streams, client(c) } to replace the random streams, used by the differential test
  constructor(config = {}, rng = null) {
    this.cfg = { ...DEFAULTS, ...config };
    const cfg = this.cfg;
    if (!["open", "closed"].includes(cfg.arrivals)) throw new Error(`unknown arrivals ${cfg.arrivals}`);
    if (!["simple", "simple_reference", "tiered"].includes(cfg.selector)) throw new Error(`unknown selector ${cfg.selector}`);
    this.engine = new Engine();
    this.rngSource = rng;
    this.rng = rng ? rng.streams : streams(cfg.seed, ...STREAMS);
    this.think = [];
    for (let c = 0; c < cfg.clients; c++) this.think.push(this.clientRng(c));
    this.clientLive = [];  // a closed client has a pending think, arrival or delayed insert
    this.pool = new Pool(this.engine, cfg.threads, cfg.threads * cfg.concurrency_ratio, cfg.scheduling_policy, task => this.onMergeDone(task));
    this.partitions = new Map([[0, []]]);  // key -> active parts ordered by block number, keys ascending
    this.partitionBytes = new Map([[0, 0]]);
    this.partCount = 0;
    this.currentPartition = 0;  // the number of rotations so far
    this.droppedPartitions = [];
    this.nextId = 1;
    this.lastBlock = 0;
    this.insertedBytes = 0;
    this.droppedBytes = 0;
    this.droppedBlocks = 0;
    this.savedBytes = 0;  // sources minus merged parts (RFC 3.1)
    this.arrivals = 0;
    this.inFlight = 0;
    this.rejected = 0;
    this.rejectedDisk = 0;  // NOT_ENOUGH_SPACE at commit
    this.outdated = [];  // [outdated at, bytes] of merge sources and dropped parts still on disk, oldest first, from outdatedHead on
    this.outdatedHead = 0;
    this.outdatedBytes = 0;
    this.delayed = 0;
    this.delayTotalMs = 0;
    this.mergedBytes = 0;
    this.mergesDone = 0;
    this.mergesAborted = 0;
    this.selectorRuns = 0;
    this.noWorkCount = 0;
    this.assigneeAt = Infinity;
    this.assigneeToken = 0;
    this.arrivalToken = 0;
    this.burstToken = 0;
    this.rotationToken = 0;
    this.activeClients = cfg.clients;
    this.insertsPaused = false;
    this.diskLimitChanged = false;  // a limit lowered from the UI may be below the used space
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
    this.peakRate = cfg.insert_rate * (1 + cfg.rate_amplitude);
    this.burstPeak = cfg.burst ? (cfg.burst[2] - 1) * this.peakRate : 0;
  }

  rate(t) {
    const cfg = this.cfg;
    return cfg.insert_rate * (1 + cfg.rate_amplitude * Math.cos(2 * Math.PI * (t - cfg.rate_peak_at) / DAY));
  }

  // the extra rate (factor - 1) λ(t) of a burst
  burstRate(t) {
    const b = this.cfg.burst;
    return b[0] <= t && t < b[0] + b[1] ? (b[2] - 1) * this.rate(t) : 0.0;
  }

  emit(type, ...data) {
    if (this.observer) this.observer(type, this.engine.now, ...data);
  }

  get parts() {
    const out = [];
    for (const parts of this.partitions.values()) out.push(...parts);
    return out;
  }

  hasBurst() {
    return this.cfg.arrivals === "open" && this.cfg.burst && this.cfg.burst[2] > 1;
  }

  start() {
    if (this.cfg.partition_seconds) this.scheduleRotation();
    if (this.cfg.arrivals === "open") {
      this.scheduleArrival();
      if (this.hasBurst()) this.scheduleBurstArrival(this.cfg.burst[0]);
    } else for (let c = 0; c < this.cfg.clients; c++) this.thinkThen(c);
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

  scheduleBurstArrival(after) {
    if (this.insertsPaused || !this.hasBurst() || this.burstPeak <= 0) return;
    const [start, duration] = this.cfg.burst;
    let t = Math.max(after, start);
    for (;;) {
      t += this.rng.burst_arrival.expovariate(this.burstPeak);
      if (t >= start + duration) return;
      if (this.rng.burst_thinning.random() * this.burstPeak <= this.burstRate(t)) break;
    }
    this.engine.schedule(t - this.engine.now, token => { if (token === this.burstToken) this.onInsertArrival(null, true); }, this.burstToken);
  }

  thinkThen(client) {
    this.clientLive[client] = true;
    this.engine.schedule(this.think[client].expovariate(1 / this.cfg.think_time), c => this.onInsertArrival(c), client);
  }

  // closed clients still in the model, the others end their loop at the next event
  clientStays(client) {
    return client < this.activeClients && !this.insertsPaused && this.cfg.arrivals === "closed";
  }

  onInsertArrival(client, burst = false) {
    if (client === null) {
      if (burst) this.scheduleBurstArrival(this.engine.now);
      else this.scheduleArrival();
    } else if (!this.clientStays(client)) {
      this.clientLive[client] = false;
      return;
    }
    this.arrivals++;
    // drawn before the throttling decision, so that the i-th insert is the same in every configuration:
    // its size, and whether its data belongs to the previous partition
    const sizeRng = burst ? this.rng.burst_size : this.rng.size;
    const size = Math.max(1, roundHalfEven(lognormal(sizeRng, this.cfg.insert_bytes_mean, this.cfg.insert_bytes_cv) * this.auxStorage));
    let target = this.currentPartition;
    if (this.cfg.partition_seconds && this.cfg.late_insert_fraction) {
      if ((burst ? this.rng.burst_partition : this.rng.partition).random() < this.cfg.late_insert_fraction) target -= 1;
    }
    // getMaxPartsCountAndSizeForPartition: on a tie the first partition wins
    let key = null, most = -1;
    for (const [k, parts] of this.partitions) if (parts.length > most) { most = parts.length; key = k; }
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
    this.engine.schedule(delay / 1000, (s, c, p, d) => this.onInsertCommit(s, c, p, d), size, client, target, delay);
  }

  // the partition of the insert's data; data of an already dropped partition goes to the current one
  partitionForInsert(target) {
    const keys = [...this.partitions.keys()];
    if (this.partitions.has(target) || target > keys[keys.length - 1]) return target;
    return this.currentPartition;
  }

  onInsertCommit(size, client, target, delay) {
    this.inFlight--;
    const key = this.partitionForInsert(target);
    // MergeTreeDataWriter reserves space for the new part; the model reserves its size on disk (RFC 3.10)
    if (this.cfg.disk_bytes && size > this.diskFree()) {
      this.rejectedDisk++;
      this.emit("nospace", size, client, delay);
      if (client !== null) this.afterInsert(client);
      return;
    }
    this.lastBlock++;
    if (!this.partitions.has(key)) this.addPartition(key);
    const part = { id: this.nextId++, minBlock: this.lastBlock, maxBlock: this.lastBlock, level: 0, size, createdAt: this.engine.now,
                   partition: key, blocks: 1, fresh: size, merging: false, pickedAt: null, removedAt: null, dropped: false, origin: null };
    this.partitions.get(key).push(part);
    this.partitionBytes.set(key, this.partitionBytes.get(key) + size);
    this.partCount++;
    this.insertedBytes += size;
    this.emit("insert", part, delay);
    this.trigger();  // MergeTreeSink wakes the assignee after every insert
    if (client !== null) this.afterInsert(client);
  }

  afterInsert(client) {
    if (this.clientStays(client)) this.thinkThen(client);
    else this.clientLive[client] = false;
  }

  addPartition(key) {
    // keys stay ascending: a new key is the largest one (partitionForInsert never returns an older missing key)
    this.partitions.set(key, []);
    this.partitionBytes.set(key, 0);
  }

  // assignee

  trigger() {
    this.noWorkCount = Math.floor(this.noWorkCount / 2);
    if (this.assigneeAt > this.engine.now + this.cfg.assign_latency) this.scheduleAssignee(this.cfg.assign_latency);
  }

  postpone() {
    this.noWorkCount++;
    // std::pow saturates to inf in ClickHouse; the cap gives the same 600 s
    const delay = Math.min(600.0, 0.1 * Math.pow(1.1, Math.min(this.noWorkCount, 200))) + this.rng.assignee.uniform(0, 1);
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
    // ClickHouse selects on a full pool too and postpones twice when the pool refuses the merge; skipping that
    // selection changes only the backoff counter, which every insert halves (RFC 3.6)
    if (!this.pool.hasCapacity()) {
      this.lastSelection = { at: this.engine.now, outcome: "pool_full" };
      return false;
    }
    this.selectorRuns++;
    const free = this.cfg.disk_bytes ? this.diskFree() : null;
    const maxBytes = maxSourcePartsBytes(this.pool.maxTasks, this.pool.tasks.length, this.cfg, free);
    const diskLimited = free !== null && maxBytes < maxSourcePartsBytes(this.pool.maxTasks, this.pool.tasks.length, this.cfg);
    if (maxBytes === 0) {
      this.lastSelection = { at: this.engine.now, outcome: this.cfg.max_bytes_at_max_space === 0 ? "disabled" : "disk_full", free };
      return false;
    }
    const stats = { considered: 0, allowed: 0 };
    const found = selectAcross(this.partitions, this.engine.now, maxBytes, this.cfg, this.cfg.selector, stats);
    if (found === null) {
      this.lastSelection = { at: this.engine.now, outcome: "nothing", maxBytes, diskLimited, ...stats };
      return false;
    }
    const sources = this.partitions.get(found.key).slice(found.begin, found.end);
    let size = 0, fresh = 0;
    for (const p of sources) {
      p.merging = true;
      p.pickedAt = this.engine.now;
      size += p.size;
      fresh += p.fresh;
    }
    const noise = lognormal(this.rng.merge, 1.0, this.cfg.merge_noise_cv);
    const work = this.mergeWork(size, fresh) * noise;
    const [resultSize, resultFresh] = this.mergedSize(size, fresh);
    const task = { id: this.nextId++, work, priority: size, payload: sources, remaining: 0, rate: 0, createdAt: 0, resultSize, resultFresh };
    this.pool.add(task);
    this.lastSelection = this.lastMerge = { at: this.engine.now, outcome: "merge", task: task.id, maxBytes, diskLimited,
                                            freeEntries: this.pool.maxTasks - this.pool.tasks.length + 1, ...stats, ...found, work };
    this.emit("assign", task, found);
    return true;
  }

  // thread-seconds of a merge before noise (RFC 3.7): the cost line is per byte of fresh data; a byte that went through
  // a large merge holds 1 / result_ratio_large times more data, and large merges are slower
  mergeWork(size, fresh) {
    const cfg = this.cfg;
    const data = (fresh + (size - fresh) / cfg.result_ratio_large) / this.auxStorage;
    let work = (cfg.merge_fixed_seconds + data / cfg.merge_bytes_per_second) * this.auxTime;
    if (cfg.large_merge_bytes && size >= cfg.large_merge_bytes) work *= cfg.large_merge_time_factor;
    return work;
  }

  // size of the merged part and its fresh bytes (RFC 3.1)
  mergedSize(size, fresh) {
    const cfg = this.cfg;
    if (cfg.large_merge_bytes && size >= cfg.large_merge_bytes) {
      return [Math.max(1, roundHalfEven(cfg.result_ratio * (size - fresh) + cfg.result_ratio_large * fresh)), 0];
    }
    return [Math.max(1, roundHalfEven(cfg.result_ratio * size)), roundHalfEven(cfg.result_ratio * fresh)];
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
    const merged = { id: task.id, minBlock: sources[0].minBlock, maxBlock: sources[sources.length - 1].maxBlock, level, size: task.resultSize,
                     createdAt: this.engine.now, partition: key, blocks, fresh: task.resultFresh, merging: false, pickedAt: null, removedAt: null,
                     dropped: false, origin: { sources: sources.length, levels: sources.map(p => p.level), assignedAt: task.createdAt, work: task.work } };
    parts.splice(begin, sources.length, merged);
    this.partCount -= sources.length - 1;
    this.partitionBytes.set(key, this.partitionBytes.get(key) + task.resultSize - task.priority);
    this.savedBytes += task.priority - task.resultSize;
    for (const p of sources) p.removedAt = this.engine.now;
    this.removeOutdated();
    this.outdated.push([this.engine.now, task.priority]);
    this.outdatedBytes += task.priority;
    this.mergedBytes += task.priority;
    this.mergesDone++;
    this.noWorkCount++;  // MergePlainMergeTreeTask::onCompleted postpones the assignee after a successful merge
    this.emit("merged", task, merged);
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
      if (key <= this.currentPartition - this.cfg.retention_partitions) this.drop(key);
    }
  }

  // DROP PARTITION: stopMergesAndWait cancels every running merge of the table first, then the parts become outdated
  drop(key) {
    this.cancelMerges();
    const parts = this.partitions.get(key);
    let size = 0;
    for (const p of parts) {
      p.removedAt = this.engine.now;
      p.dropped = true;
      size += p.size;
      this.droppedBlocks += p.blocks;
    }
    this.droppedBytes += size;
    this.partCount -= parts.length;
    this.partitions.delete(key);
    this.partitionBytes.delete(key);
    this.removeOutdated();
    this.outdated.push([this.engine.now, size]);
    this.outdatedBytes += size;
    if (!this.partitions.size) this.addPartition(this.currentPartition);
    this.droppedPartitions.push([key, this.engine.now]);
    this.emit("drop", key, parts.length);
  }

  cancelMerges() {
    const tasks = this.pool.cancelAll();
    for (const task of tasks) {
      for (const p of task.payload) {
        p.merging = false;
        p.pickedAt = null;
      }
      this.mergesAborted++;
      this.emit("cancel", task);
    }
    if (tasks.length) {
      // the cancelled tasks wake the assignee, which finds merges blocked by the DROP and goes to sleep
      this.noWorkCount = Math.floor(this.noWorkCount / 2);
      this.postpone();
    }
  }

  // disk (RFC 3.10)

  // clearOldPartsFromFilesystem: outdated parts older than old_parts_lifetime leave the disk
  removeOutdated() {
    const q = this.outdated, lifetime = this.cfg.old_parts_lifetime, now = this.engine.now;
    while (this.outdatedHead < q.length && q[this.outdatedHead][0] + lifetime <= now) this.outdatedBytes -= q[this.outdatedHead++][1];
    if (this.outdatedHead > 4096 && this.outdatedHead * 2 > q.length) {
      this.outdated = q.slice(this.outdatedHead);
      this.outdatedHead = 0;
    }
  }

  // bytes written or reserved by running merges: MergeTask shrinks the reservation to (1 - progress) of the initial one
  mergingBytes() {
    let merging = 0;
    for (const task of this.pool.tasks) {
      const progress = task.work > 0 ? Math.min(1.0, Math.max(0.0, 1.0 - this.pool.remainingNow(task) / task.work)) : 1.0;
      merging += task.resultSize * progress + task.priority * RESERVE_RATIO * (1 - progress);
    }
    return merging;
  }

  // active parts, outdated parts not yet removed, and running merges
  diskUsed() {
    this.removeOutdated();
    return this.insertedBytes - this.droppedBytes - this.savedBytes + this.outdatedBytes + this.mergingBytes();
  }

  // getMaxUnreservedFreeSpace for the table
  diskFree() {
    return Math.max(0.0, this.cfg.disk_bytes - this.diskUsed());
  }

  // live changes from the UI; each takes effect from the current model time

  configure(changes) {
    const cfg = this.cfg, old = { ...cfg };
    Object.assign(cfg, changes);
    this.updateDerived();
    const open = cfg.arrivals === "open";
    if (["insert_rate", "rate_amplitude"].some(k => k in changes) && open) this.restartArrivals();
    if (["insert_rate", "rate_amplitude", "burst"].some(k => k in changes) && open) this.restartBurst();
    if ("arrivals" in changes && changes.arrivals !== old.arrivals) {
      this.arrivalToken++;
      this.burstToken++;
      if (open) this.restartArrivals();
      else this.startIdleClients();
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
    if ("disk_bytes" in changes && changes.disk_bytes !== old.disk_bytes) this.diskLimitChanged = true;
    this.trigger();  // new selector settings may allow a merge right away
  }

  restartArrivals() {
    this.arrivalToken++;
    this.scheduleArrival();
  }

  restartBurst() {
    this.burstToken++;
    this.scheduleBurstArrival(this.engine.now);
  }

  startIdleClients() {
    if (this.cfg.arrivals !== "closed" || this.insertsPaused) return;
    for (let c = 0; c < this.activeClients; c++) if (!this.clientLive[c]) this.thinkThen(c);
  }

  setClients(n) {
    while (this.think.length < n) this.think.push(this.clientRng(this.think.length));
    this.activeClients = n;
    this.startIdleClients();
  }

  setInsertsPaused(paused) {
    if (paused === this.insertsPaused) return;
    this.insertsPaused = paused;
    if (paused) {
      this.arrivalToken++;
      this.burstToken++;
      return;
    }
    if (this.cfg.arrivals === "open") {
      this.restartArrivals();
      this.restartBurst();
    } else this.startIdleClients();
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
    this.drop(keys[0]);
    return true;
  }

  // checks of RFC section 7
  checkInvariants() {
    const parts = this.parts;
    let size = 0, blocks = 0, merging = 0;
    for (const p of parts) { size += p.size; blocks += p.blocks; if (p.merging) merging++; }
    assert(size === this.insertedBytes - this.droppedBytes - this.savedBytes, "byte balance");
    assert(blocks === this.lastBlock - this.droppedBlocks, "block balance");
    assert(parts.length === this.partCount, "part count");
    assert(this.arrivals === this.lastBlock + this.inFlight + this.rejected + this.rejectedDisk, "insert balance");
    let prevKey = -Infinity;
    for (const [key, ps] of this.partitions) {
      assert(key > prevKey, "partition keys ascending");
      prevKey = key;
      let bytes = 0;
      ps.forEach((p, i) => {
        bytes += p.size;
        assert(p.partition === key && p.maxBlock >= p.minBlock && !p.dropped, "part fields");
        assert(p.blocks <= p.maxBlock - p.minBlock + 1 && p.fresh >= 0 && p.fresh <= p.size, "part contents");
        if (i) assert(ps[i - 1].maxBlock < p.minBlock, "parts ordered and disjoint");
      });
      assert(bytes === this.partitionBytes.get(key), "partition bytes");
    }
    if (this.partitions.size === 1 && !this.droppedPartitions.length) {
      // one partition, nothing dropped: the parts cover the blocks 1..lastBlock without gaps
      let expected = 1;
      for (const p of parts) { assert(p.minBlock === expected, "blocks without gaps"); expected = p.maxBlock + 1; }
      assert(expected === this.lastBlock + 1, "all blocks covered");
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
    if (this.cfg.disk_bytes && !this.diskLimitChanged) assert(this.diskUsed() <= this.cfg.disk_bytes * (1 + 1e-9), "disk limit");
  }
}

function assert(condition, message) {
  if (!condition) throw new Error("invariant: " + message);
}
