// The laboratory: a live model in the page, or two of them side by side (A and B) on the same random numbers.
// The models run in the animation loop with a time budget per frame, so the page stays responsive; when they
// cannot keep up, the real speed is shown next to the requested one.

import { Table } from "../sim/model.js";
import { CALIBRATED } from "../data/calibration.js";
import { el, sv, bytes, clock, INT, NUM, NUM2, PCT, plural } from "./dom.js";
import { Chart, S } from "./charts.js";
import { Controls, PRESETS, describeDifferences } from "./controls.js";
import { EventLog } from "./eventlog.js";
import { Inspector, findPart } from "./inspector.js";
import { PoolView } from "./poolview.js";
import { Sampler } from "./sampler.js";
import { PartsTree } from "./tree.js";

const FRAME_BUDGET_MS = 14;
const SIGNIFICANT = new Set(["insert", "assign", "merged", "drop", "rotate", "arrival", "nospace"]);
// aux keeps its items: the panel recognises the index and the projection by identity
const copy = cfg => ({ ...cfg, aux: [...(cfg.aux || [])] });

export class Lab {
  constructor() {
    this.playing = false;
    this.speed = 10;
    this.realSpeed = 0;
    this.window = 600;
    this.presetKey = "normal";
    this.seed = 1;
    this.b = null;  // the model the parameter panel edits
    this.a = null;  // the fixed baseline while comparing
    this.view = "B";  // which model the tree, the pool and the log show
    this.$ = id => document.getElementById(id);
    this.tree = new PartsTree(this.$("tree"), { onPick: s => this.pick(s) });
    this.pool = new PoolView(this.$("pool"), { onPick: s => this.pick(s) });
    this.inspector = new Inspector(this.$("inspector"), this.$("explain"), s => this.pick(s));
    this.log = new EventLog(this.$("log"), ref => this.pick(ref));
    this.controls = new Controls(this.$("params"), this);
    this.bindToolbar();
    this.buildCharts();
    this.load("normal");
    let last = null;
    const frame = ts => {
      this.frame(last == null ? 0 : Math.min(0.25, (ts - last) / 1000));
      last = ts;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    setInterval(() => this.slowUpdate(), 400);
  }

  get table() { return this.b.table; }
  get sampler() { return this.b.sampler; }
  shown() { return this.view === "A" && this.a ? this.a : this.b; }
  models() { return this.a ? [this.a, this.b] : [this.b]; }

  // the API of the parameter panel
  config() { return this.b.table.cfg; }

  configure(changes) {
    this.b.table.configure(changes);
    this.controls.sync();
    this.syncCompare();
    this.drawAll();
  }

  load(presetKey) {
    this.presetKey = presetKey;
    const config = { ...CALIBRATED, seed: this.seed, ...PRESETS[presetKey].config };
    this.start(config, this.a ? config : null);
    this.controls.sync(presetKey);
  }

  // B and, when comparing, A from time zero
  start(bConfig, aConfig = null) {
    this.b = this.makeModel(bConfig);
    this.a = aConfig ? this.makeModel(aConfig) : null;
    if (!this.a) this.view = "B";
    this.log.show(this.shown().log);
    this.tree.reset();
    this.pool.reset();
    this.inspector.select(null);
    this.paused = false;
    this.controls.setPaused(false);
    this.controls.sync();
    this.syncCompare();
    this.drawAll();
    this.slowUpdate();
    if (!this.playing) this.toggle();  // start right away: the point is to watch it run
  }

  makeModel(config) {
    const table = new Table(copy(config));
    const m = { table, sampler: new Sampler(table), log: EventLog.newState() };
    table.observer = (type, t, ...data) => {
      m.sampler.observe(type, t, ...data);
      this.log.observe(m.log, type, t, ...data);
      if (m === this.shown() && SIGNIFICANT.has(type) && (type !== "arrival" || data[0] !== 0)) this.lastSignificant = type;
    };
    for (const [at, name, ...args] of PRESETS[this.presetKey].actions || []) {
      table.engine.schedule(at, () => {
        if (name === "burst") {
          table.burst(...args);
          this.log.push(m.log, table.engine.now, "throttle", `Сплеск: потік ×${args[0]} на ${args[1]} с`);
        }
      });
    }
    table.start();
    return m;
  }

  // a new run from time zero: with the preset, or with both current configurations while comparing
  restart() {
    if (this.a) this.start({ ...this.b.table.cfg, seed: this.seed }, { ...this.a.table.cfg, seed: this.seed });
    else this.load(this.presetKey);
  }

  toggleCompare() {
    if (this.a) {
      this.a = null;  // B keeps running
      this.setView("B");
      return;
    }
    const config = { ...this.b.table.cfg, seed: this.seed };
    this.start(config, config);
  }

  setView(view) {
    this.view = this.a ? view : "B";
    this.log.show(this.shown().log);
    this.tree.reset();
    this.pool.reset();
    this.inspector.select(null);
    this.syncCompare();
    this.drawAll();
    this.slowUpdate();
  }

  syncCompare() {
    const on = !!this.a, button = this.$("compare");
    button.setAttribute("aria-pressed", String(on));
    button.textContent = on ? "Вимкнути порівняння" : "Порівняти A і B";
    this.$("compare-bar").hidden = !on;
    this.$("log-title").textContent = on ? `Журнал подій моделі ${this.view}` : "Журнал подій";
    for (const b of this.$("compare-view").children) b.setAttribute("aria-pressed", String(b.dataset.value === this.view));
    if (!on) return;
    const diff = describeDifferences(this.a.table.cfg, this.b.table.cfg);
    this.$("compare-diff").replaceChildren(...(diff.length ? diff.map(d => el("li", {}, d))
      : [el("li", { class: "same" }, "Поки A і B однакові. Змініть параметр на панелі, і він зміниться тільки в B.")]));
  }

  action(name) {
    const models = this.models();
    if (name === "burst") {
      const [factor, length] = this.controls.burstSettings();
      for (const m of models) {
        m.table.burst(factor, length);
        this.log.push(m.log, m.table.engine.now, "throttle", `Сплеск: потік ×${factor} на ${length} с`);
      }
    } else if (name === "pause") {
      this.paused = !this.paused;
      for (const m of models) {
        m.table.setInsertsPaused(this.paused);
        this.log.push(m.log, m.table.engine.now, "insert", this.paused ? "Вставки зупинено" : "Вставки відновлено");
      }
      this.controls.setPaused(this.paused);
    } else if (name === "rotate") {
      for (const m of models) m.table.newPartitionNow();
    } else if (name === "drop") {
      for (const m of models) {
        if (!m.table.dropOldestPartition()) this.log.push(m.log, m.table.engine.now, "partition", "Найстарішу партицію не видалено: у ній ще йдуть злиття, її видалять після них");
      }
    }
    this.controls.sync();
    this.syncCompare();
    this.drawAll();
  }

  bindToolbar() {
    this.$("play").addEventListener("click", () => this.toggle());
    this.$("step").addEventListener("click", () => this.step());
    this.$("speed").addEventListener("change", e => { this.speed = +e.target.value; });
    this.$("reset").addEventListener("click", () => this.restart());
    this.$("compare").addEventListener("click", () => this.toggleCompare());
    for (const b of this.$("compare-view").children) b.addEventListener("click", () => this.setView(b.dataset.value));
    this.$("seed").addEventListener("change", e => {
      this.seed = Math.max(1, Math.round(+e.target.value) || 1);
      e.target.value = this.seed;
      this.restart();
    });
    this.$("window").addEventListener("change", e => { this.window = +e.target.value; this.updateCharts(); });
    document.addEventListener("keydown", e => {
      if (this.$("tab-lab").hidden || ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
      if (e.code === "Space") { e.preventDefault(); this.toggle(); }
      if (e.code === "ArrowRight") { e.preventDefault(); this.step(); }
    });
  }

  toggle() {
    this.playing = !this.playing;
    this.$("play").textContent = this.playing ? "⏸ Пауза" : "▶ Пуск";
  }

  pause() {
    if (this.playing) this.toggle();
  }

  // the shown model to its next event that changes something visible, the other one to the same time
  step() {
    this.pause();
    const m = this.shown();
    this.lastSignificant = null;
    for (let i = 0; i < 100000 && !this.lastSignificant; i++) if (!m.table.engine.step()) break;
    for (const other of this.models()) if (other !== m) other.table.engine.run(m.table.engine.now);
    this.drawAll();
    this.slowUpdate();
  }

  frame(dt) {
    if (!this.playing) return;
    const main = this.b.table.engine, engines = this.models().map(m => m.table.engine);
    const target = main.now + dt * this.speed;
    const started = performance.now(), from = main.now;
    // the earliest event of both models first, so that A and B stay at the same model time
    for (;;) {
      let e = engines[0];
      for (const x of engines) if (x.peekTime() < e.peekTime()) e = x;
      if (e.peekTime() > target) break;
      e.step();
      if (performance.now() - started > FRAME_BUDGET_MS) break;
    }
    for (const e of engines) if (e.peekTime() > target) e.now = target;
    if (dt > 0) this.realSpeed = 0.9 * this.realSpeed + 0.1 * ((main.now - from) / dt);
    this.drawAll();
  }

  pick(selection) {
    const tb = this.shown().table;
    if (selection && selection.task != null && !tb.pool.tasks.some(t => t.id === selection.task)) {
      // a finished merge: show the part it made, if it still exists
      const part = findPart(tb, selection.task);
      selection = part ? { part: part.id } : selection;
    }
    this.inspector.select(selection);
    this.tree.selectedPart = selection && selection.part != null ? selection.part : null;
    this.tree.highlightTask = selection && selection.task != null ? selection.task : null;
    this.pool.selected = this.tree.highlightTask;
    this.drawAll();
  }

  drawAll() {
    const tb = this.shown().table;
    if (this.inspector.selection && this.inspector.selection.task != null) {
      this.tree.highlightTask = this.inspector.selection.task;
      this.pool.selected = this.inspector.selection.task;
    }
    this.tree.draw(tb);
    this.pool.draw(tb.pool);
    this.tiles();
    this.inspector.draw(tb);
    this.$("clock").textContent = clock(this.b.table.engine.now);
    const real = this.playing && this.realSpeed < this.speed * 0.8 ? ` (фактично ×${NUM.format(this.realSpeed)})` : "";
    this.$("speed-real").textContent = real;
  }

  // things that need not change at frame rate
  slowUpdate() {
    this.log.render();
    this.updateCharts();
    if (!this.$("tab-model").hidden) this.updateDiagram();
  }

  // live numbers on the model diagram
  updateDiagram() {
    const model = this.shown(), tb = model.table, cfg = tb.cfg, set = (id, text) => { this.$(id).textContent = text; };
    const w = model.sampler.totals(10), span = Math.max(1, w.span);
    set("live-clients", cfg.arrivals === "open" ? `${NUM.format(cfg.insert_rate)} вставок/с` : `${INT.format(tb.activeClients)} клієнтів`);
    let n = 0;
    for (const parts of tb.partitions.values()) n = Math.max(n, parts.length);
    set("live-check", n >= cfg.parts_to_throw_insert ? `n = ${INT.format(n)}: відхилення`
      : n >= cfg.parts_to_delay_insert ? `n = ${INT.format(n)}: затримка` : `n = ${INT.format(n)}: без затримки`);
    set("live-parts", `${INT.format(tb.partCount)} шт`);
    set("live-assignee", tb.assigneeAt === Infinity || tb.assigneeAt <= tb.engine.now ? `${INT.format(w.merges / span * 60)} злиттів/хв` : `спить ${NUM.format(tb.assigneeAt - tb.engine.now)} с`);
    const m = tb.lastMerge;
    set("live-selector", m ? (m.tiered ? `${m.count} шт` : `${m.count} шт, base′ ${NUM2.format(m.loweredBase)}`) : "—");
    set("live-pool", `${NUM.format(tb.pool.busyThreads())} з ${tb.pool.threads} потоків`);
    // the newest partition as a row of parts: width by the logarithm of the size, colour by level
    const parts = [...tb.partitions.values()].pop() || [];
    const shown = parts.slice(-40);
    const weights = shown.map(p => Math.log10(Math.max(10, p.size / 1e5)));
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    const g = this.$("model-parts");
    g.replaceChildren();
    let x = 898;
    shown.forEach((p, i) => {
      const w = 270 * weights[i] / total;
      g.append(sv("rect", { x, y: 164, width: Math.max(0.5, w - 1.5), height: 16, rx: 2,
                            style: `fill:var(--level-${Math.min(4, p.level)})${p.merging ? ";stroke:var(--series-2);stroke-width:1.5" : ""}` }));
      x += w;
    });
  }

  tiles() {
    const b = metrics(this.b), a = this.a ? metrics(this.a) : null, cfg = this.b.table.cfg;
    const text = (id, value) => { this.$(id).textContent = value; };
    text("v-parts", INT.format(b.parts));
    text("d-parts", a ? versus(a.parts, b.parts, v => INT.format(v))
      : b.partitions > 1 || cfg.partition_seconds ? `${b.partitions} ${plural(b.partitions, "партиція", "партиції", "партицій")}, найбільша ${INT.format(b.largest)}`
      : b.largest >= cfg.parts_to_throw_insert ? `≥ ${INT.format(cfg.parts_to_throw_insert)}: вставки відхиляються`
      : b.largest >= cfg.parts_to_delay_insert ? `≥ ${INT.format(cfg.parts_to_delay_insert)}: вставки гальмуються`
      : `гальмування з ${INT.format(cfg.parts_to_delay_insert)}`);
    this.$("v-busy").replaceChildren(NUM.format(b.busy), el("small", {}, "з " + b.threads));
    meter(this.$("m-busy"), b.busy / b.threads, b.busy >= b.threads - 1e-9);
    text("d-busy", a ? versus(a.busy, b.busy, v => NUM.format(v)) : `задач злиття ${INT.format(b.tasks)} з ${INT.format(b.maxTasks)}`);
    text("v-wa", b.wa != null ? NUM2.format(b.wa) : "—");
    text("d-wa", a ? versus(a.wa, b.wa, v => NUM2.format(v)) : b.waTotal != null ? `з початку ${NUM2.format(b.waTotal)}` : "");
    this.$("v-rate").replaceChildren(INT.format(b.rate), el("small", {}, "/с"));
    const chips = [el("span", { class: "status warning" }, el("span", { class: "icon" }, "▲"), `затримано ${PCT.format(b.delayed)}`), "  ",
                   el("span", { class: "status critical" }, el("span", { class: "icon" }, "✕"), `відхилено ${PCT.format(b.rejected)}${b.nospace ? `, без місця ${PCT.format(b.nospace)}` : ""}`)];
    if (a) chips.push(el("div", {}, `A: ${INT.format(a.rate)}/с, затримано ${PCT.format(a.delayed)}, відхилено ${PCT.format(a.rejected)}`));
    this.$("d-rate").replaceChildren(...chips);
    text("v-merge", b.merge != null ? NUM.format(b.merge) + " с" : "—");
    text("d-merge", a ? versus(a.merge, b.merge, v => NUM.format(v) + " с") : `${INT.format(b.mergesPerMin)} злиттів за хвилину · ${bytes(b.mergedRate)}/с`);
    this.$("v-disk").replaceChildren(bytes(b.used), b.limit ? el("small", {}, "з " + bytes(b.limit)) : "");
    this.$("m-disk").hidden = !b.limit;
    meter(this.$("m-disk"), b.limit ? b.used / b.limit : 0, b.limit > 0 && b.used >= 0.9 * b.limit);
    text("d-disk", a ? versus(a.used, b.used, bytes) : `${b.limit ? "" : "без обмеження · "}застарілі куски ${bytes(b.outdated)}`);
  }

  buildCharts() {
    const minutes = v => clock(v * 60);
    const title = x => "момент " + clock(x * 60);
    const opts = extra => ({ height: 190, x: { format: minutes }, y: { min: 0, format: v => INT.format(v) }, tooltipTitle: title, series: [], ...extra });
    this.charts = {
      parts: new Chart(this.$("c-parts"), opts({ valueFormat: v => INT.format(v) })),
      busy: new Chart(this.$("c-busy"), opts({ valueFormat: v => NUM.format(v) })),
      inserts: new Chart(this.$("c-inserts"), opts({ valueFormat: v => NUM.format(v) + "/с" })),
      wa: new Chart(this.$("c-wa"), opts({ y: { min: 0, format: v => NUM.format(v) }, valueFormat: v => NUM2.format(v) })),
      disk: new Chart(this.$("c-disk"), opts({ y: { min: 0, format: v => bytes(v) }, valueFormat: v => bytes(v) })),
      cap: new Chart(this.$("c-cap"), opts({ y: { log: true, format: v => bytes(v) }, valueFormat: v => bytes(v) })),
    };
  }

  updateCharts() {
    const B = this.view_(this.b), cfgB = this.b.table.cfg;
    if (this.a) {
      const A = this.view_(this.a), cfgA = this.a.table.cfg;
      const pair = f => [{ name: "A: базова", short: "A", color: S(1), points: f(A) }, { name: "B: змінена", short: "B", color: S(2), points: f(B) }];
      const marks = (label, va, vb) => (va === vb ? [{ y: vb, label }] : [{ y: va, label: "A: " + label }, { y: vb, label: "B: " + label }]);
      this.charts.parts.setSeries(pair(v => v.pts(v.col("parts"))), {
        thresholds: [...marks("parts_to_delay_insert", cfgA.parts_to_delay_insert, cfgB.parts_to_delay_insert),
                     ...marks("parts_to_throw_insert", cfgA.parts_to_throw_insert, cfgB.parts_to_throw_insert)] });
      this.charts.busy.setSeries(pair(v => v.pts(v.smooth("busy"))), { thresholds: marks("потоків у пулі", this.a.table.pool.threads, this.b.table.pool.threads) });
      this.charts.inserts.setSeries(pair(v => v.pts(v.smooth("accepted"))));
      this.charts.wa.setSeries(pair(v => v.wa()));
      this.charts.disk.setSeries(pair(v => v.pts(v.col("used"))), { thresholds: marks("disk_bytes", cfgA.disk_bytes, cfgB.disk_bytes).filter(t => t.y > 0) });
      this.charts.cap.setSeries(pair(v => v.cap()));
      return;
    }
    const partsSeries = [{ name: "усі куски", short: "усі", color: S(1), points: B.pts(B.col("parts")) }];
    if (B.w.some(s => s.partitions > 1)) partsSeries.push({ name: "найбільша партиція", short: "найбільша", color: S(2), points: B.pts(B.col("largest")) });
    partsSeries.push({ name: "свіжі куски (рівень 0)", short: "свіжі", color: S(3), points: B.pts(B.col("fresh")) });
    this.charts.parts.setSeries(partsSeries, { thresholds: [{ y: cfgB.parts_to_delay_insert, label: "parts_to_delay_insert" }, { y: cfgB.parts_to_throw_insert, label: "parts_to_throw_insert" }] });
    this.charts.busy.setSeries([
      { name: "зайняті потоки", short: "потоки", color: S(1), points: B.pts(B.smooth("busy")) },
      { name: "задачі в пулі", short: "задачі", color: S(2), points: B.pts(B.smooth("tasks")) },
    ], { thresholds: [{ y: this.b.table.pool.threads, label: "потоків у пулі" }] });
    const accepted = B.smooth("accepted"), delayed = B.smooth("delayed"), rejected = B.smooth("rejected"), nospace = B.smooth("nospace");
    this.charts.inserts.setSeries([
      { name: "прийняті без затримки", short: "без затримки", color: S(1), points: B.pts(accepted.map((v, i) => Math.max(0, v - delayed[i]))) },
      { name: "затримані", short: "затримані", color: "var(--warning)", points: B.pts(delayed) },
      { name: "відхилені", short: "відхилені", color: "var(--critical)", points: B.pts(rejected.map((v, i) => v + nospace[i])) },
    ]);
    this.charts.wa.setSeries([{ name: "підсилення записів за хвилину", color: S(1), points: B.wa() }]);
    this.charts.disk.setSeries([
      { name: "зайнято", short: "зайнято", color: S(1), points: B.pts(B.col("used")) },
      { name: "з них застарілі куски", short: "застарілі", color: S(2), points: B.pts(B.col("outdated")) },
    ], { thresholds: cfgB.disk_bytes ? [{ y: cfgB.disk_bytes, label: "disk_bytes" }] : [] });
    this.charts.cap.setSeries([{ name: "межа розміру злиття", color: S(1), points: B.cap() }]);
  }

  // the samples of one model in the chart window, with helpers to turn them into points
  view_(m) {
    const w = m.sampler.window(this.window), T = w.map(s => s.t / 60);
    const pts = arr => T.map((t, i) => [t, arr[i]]);
    const col = key => w.map(s => s[key]);
    const smooth = (key, k = 5) => w.map((_, i) => { let sum = 0, n = 0; for (let j = Math.max(0, i - k + 1); j <= i; j++) { sum += w[j][key]; n++; } return sum / n; });
    const wa = () => { const merged = smooth("merged", 60), inserted = smooth("inserted", 60); return pts(merged.map((x, i) => (inserted[i] ? x / inserted[i] : null))); };
    const cap = () => pts(col("cap").map(v => (v > 0 ? v : null)));  // no merge fits: a gap on the log axis
    return { w, pts, col, smooth, wa, cap };
  }
}

// what the tiles show for one model
function metrics({ table: tb, sampler }) {
  let largest = 0;
  for (const parts of tb.partitions.values()) largest = Math.max(largest, parts.length);
  const w = sampler.totals(60), span = Math.max(1, w.span), arrivals = w.accepted + w.rejected + w.nospace;
  return {
    parts: tb.partCount, largest, partitions: tb.partitions.size,
    busy: tb.pool.busyThreads(), threads: tb.pool.threads, tasks: tb.pool.tasks.length, maxTasks: tb.pool.maxTasks,
    wa: w.inserted ? w.merged / w.inserted : null, waTotal: tb.insertedBytes ? tb.mergedBytes / tb.insertedBytes : null,
    rate: w.accepted / span,
    delayed: arrivals ? w.delayed / arrivals : 0,
    rejected: arrivals ? (w.rejected + w.nospace) / arrivals : 0,
    nospace: arrivals ? w.nospace / arrivals : 0,
    merge: w.merges ? w.mergeTime / w.merges : null, mergesPerMin: w.merges / span * 60, mergedRate: w.merged / span,
    used: tb.diskUsed(), outdated: tb.outdatedBytes, limit: tb.cfg.disk_bytes,
  };
}

// "A: 120 · B +15%"
function versus(a, b, format) {
  if (a == null) return "A: —";
  if (b == null || !a) return `A: ${format(a)}`;
  const rel = (b - a) / Math.abs(a);
  return `A: ${format(a)} · ${Math.abs(rel) < 0.005 ? "однаково" : `B ${rel > 0 ? "+" : "−"}${PCT.format(Math.abs(rel))}`}`;
}

function meter(node, fraction, full) {
  node.firstElementChild.style.width = Math.min(100, 100 * Math.max(0, fraction)) + "%";
  node.classList.toggle("full", full);
}
