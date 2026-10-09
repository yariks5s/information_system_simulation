// The laboratory: a live model in the page. The model runs in the animation loop with a time budget per frame,
// so the page stays responsive; when the model cannot keep up, the real speed is shown next to the requested one.

import { Table } from "../sim/model.js";
import { CALIBRATED } from "../data/calibration.js";
import { el, sv, bytes, clock, INT, NUM, NUM2, PCT, plural } from "./dom.js";
import { Chart, S } from "./charts.js";
import { Controls, PRESETS } from "./controls.js";
import { EventLog } from "./eventlog.js";
import { Inspector, findPart } from "./inspector.js";
import { PoolView } from "./poolview.js";
import { Sampler } from "./sampler.js";
import { PartsTree } from "./tree.js";

const FRAME_BUDGET_MS = 14;
const SIGNIFICANT = new Set(["insert", "assign", "merged", "drop", "rotate", "arrival"]);

export class Lab {
  constructor() {
    this.playing = false;
    this.speed = 10;
    this.realSpeed = 0;
    this.window = 600;
    this.presetKey = "normal";
    this.seed = 1;
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

  // the API of the parameter panel
  config() { return this.table.cfg; }

  configure(changes) {
    this.table.configure(changes);
    this.controls.sync();
    this.drawAll();
  }

  load(presetKey) {
    this.presetKey = presetKey;
    const preset = PRESETS[presetKey];
    this.table = new Table({ ...CALIBRATED, seed: this.seed, ...preset.config });
    this.sampler = new Sampler(this.table);
    this.log.clear();
    this.tree.reset();
    this.pool.reset();
    this.inspector.select(null);
    this.table.observer = (type, t, ...data) => {
      this.sampler.observe(type, t, ...data);
      this.log.observe(type, t, ...data);
      if (SIGNIFICANT.has(type) && (type !== "arrival" || data[0] !== 0)) this.lastSignificant = type;
    };
    for (const [at, name, ...args] of preset.actions || []) {
      this.table.engine.schedule(at, () => {
        if (name === "burst") {
          this.table.burst(...args);
          this.log.push(this.table.engine.now, "throttle", `Сплеск: потік ×${args[0]} на ${args[1]} с`);
        }
      });
    }
    this.table.start();
    this.paused = false;
    this.controls.sync(presetKey);
    this.controls.setPaused(false);
    this.drawAll();
    this.slowUpdate();
    if (!this.playing) this.toggle();  // start right away: the point is to watch it run
  }

  action(name) {
    const tb = this.table, now = tb.engine.now;
    if (name === "burst") {
      const [factor, length] = this.controls.burstSettings();
      tb.burst(factor, length);
      this.log.push(now, "throttle", `Сплеск: потік ×${factor} на ${length} с`);
    } else if (name === "pause") {
      this.paused = !this.paused;
      tb.setInsertsPaused(this.paused);
      this.controls.setPaused(this.paused);
      this.log.push(now, "insert", this.paused ? "Вставки зупинено" : "Вставки відновлено");
    } else if (name === "rotate") {
      tb.newPartitionNow();
    } else if (name === "drop") {
      if (!tb.dropOldestPartition()) this.log.push(now, "partition", "Найстарішу партицію не видалено: у ній ще йдуть злиття, її видалять після них");
    }
    this.controls.sync();
    this.drawAll();
  }

  bindToolbar() {
    this.$("play").addEventListener("click", () => this.toggle());
    this.$("step").addEventListener("click", () => this.step());
    this.$("speed").addEventListener("change", e => { this.speed = +e.target.value; });
    this.$("reset").addEventListener("click", () => this.load(this.presetKey));
    this.$("seed").addEventListener("change", e => { this.seed = Math.max(1, Math.round(+e.target.value) || 1); e.target.value = this.seed; this.load(this.presetKey); });
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

  // to the next event that changes something visible
  step() {
    this.pause();
    this.lastSignificant = null;
    for (let i = 0; i < 100000 && !this.lastSignificant; i++) if (!this.table.engine.step()) break;
    this.drawAll();
    this.slowUpdate();
  }

  frame(dt) {
    if (!this.playing) return;
    const engine = this.table.engine;
    const target = engine.now + dt * this.speed;
    const started = performance.now(), from = engine.now;
    while (engine.peekTime() <= target) {
      engine.step();
      if (performance.now() - started > FRAME_BUDGET_MS) break;
    }
    if (engine.peekTime() > target) engine.now = target;
    if (dt > 0) this.realSpeed = 0.9 * this.realSpeed + 0.1 * ((engine.now - from) / dt);
    this.drawAll();
  }

  pick(selection) {
    if (selection && selection.task != null && !this.table.pool.tasks.some(t => t.id === selection.task)) {
      // a finished merge: show the part it made, if it still exists
      const part = findPart(this.table, selection.task);
      selection = part ? { part: part.id } : selection;
    }
    this.inspector.select(selection);
    this.tree.selectedPart = selection && selection.part != null ? selection.part : null;
    this.tree.highlightTask = selection && selection.task != null ? selection.task : null;
    this.pool.selected = this.tree.highlightTask;
    this.drawAll();
  }

  drawAll() {
    const tb = this.table;
    if (this.inspector.selection && this.inspector.selection.task != null) {
      this.tree.highlightTask = this.inspector.selection.task;
      this.pool.selected = this.inspector.selection.task;
    }
    this.tree.draw(tb);
    this.pool.draw(tb.pool);
    this.tiles();
    this.inspector.draw(tb);
    this.$("clock").textContent = clock(tb.engine.now);
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
    const tb = this.table, cfg = tb.cfg, set = (id, text) => { this.$(id).textContent = text; };
    const w = this.sampler.totals(10), span = Math.max(1, w.span);
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
    const tb = this.table, cfg = tb.cfg;
    let largest = 0;
    for (const parts of tb.partitions.values()) largest = Math.max(largest, parts.length);
    this.$("v-parts").textContent = INT.format(tb.partCount);
    const n = tb.partitions.size;
    this.$("d-parts").textContent = n > 1 || cfg.partition_seconds
      ? `${n} ${plural(n, "партиція", "партиції", "партицій")}, найбільша ${INT.format(largest)}`
      : largest >= cfg.parts_to_throw_insert ? `≥ ${INT.format(cfg.parts_to_throw_insert)}: вставки відхиляються`
      : largest >= cfg.parts_to_delay_insert ? `≥ ${INT.format(cfg.parts_to_delay_insert)}: вставки гальмуються`
      : `гальмування з ${INT.format(cfg.parts_to_delay_insert)}`;
    const busy = tb.pool.busyThreads(), threads = tb.pool.threads;
    this.$("v-busy").replaceChildren(NUM.format(busy), el("small", {}, "з " + threads));
    const mb = this.$("m-busy");
    mb.firstElementChild.style.width = Math.min(100, 100 * busy / threads) + "%";
    mb.classList.toggle("full", busy >= threads - 1e-9);
    this.$("v-tasks").replaceChildren(INT.format(tb.pool.tasks.length), el("small", {}, "з " + tb.pool.maxTasks));
    this.$("m-tasks").firstElementChild.style.width = Math.min(100, 100 * tb.pool.tasks.length / tb.pool.maxTasks) + "%";
    const w = this.sampler.totals(60);
    this.$("v-wa").textContent = w.inserted ? NUM2.format(w.merged / w.inserted) : "—";
    this.$("d-wa").textContent = tb.insertedBytes ? `з початку ${NUM2.format(tb.mergedBytes / tb.insertedBytes)}` : "";
    const span = Math.max(1, w.span), arrivals = w.accepted + w.rejected;
    this.$("v-rate").replaceChildren(INT.format(w.accepted / span), el("small", {}, "/с прийнято"));
    const d = this.$("d-rate");
    d.replaceChildren(el("span", { class: "status warning" }, el("span", { class: "icon" }, "▲"), `затримано ${arrivals ? PCT.format(w.delayed / arrivals) : "0%"}`), "  ",
                      el("span", { class: "status critical" }, el("span", { class: "icon" }, "✕"), `відхилено ${arrivals ? PCT.format(w.rejected / arrivals) : "0%"}`));
    this.$("v-merge").textContent = w.merges ? NUM.format(w.mergeTime / w.merges) + " с" : "—";
    this.$("d-merge").textContent = `${INT.format(w.merges / span * 60)} злиттів за хвилину · ${bytes(w.merged / span)}/с`;
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
    };
  }

  updateCharts() {
    const tb = this.table, cfg = tb.cfg;
    const w = this.sampler.window(this.window);
    const T = w.map(s => s.t / 60);
    const smooth = (key, k = 5) => w.map((_, i) => { let sum = 0, n = 0; for (let j = Math.max(0, i - k + 1); j <= i; j++) { sum += w[j][key]; n++; } return sum / n; });
    const pts = arr => T.map((t, i) => [t, arr[i]]);
    const partsSeries = [{ name: "усі куски", short: "усі", color: S(1), points: pts(w.map(s => s.parts)) }];
    if (w.some(s => s.partitions > 1)) partsSeries.push({ name: "найбільша партиція", short: "найбільша", color: S(2), points: pts(w.map(s => s.largest)) });
    partsSeries.push({ name: "свіжі куски (рівень 0)", short: "свіжі", color: S(3), points: pts(w.map(s => s.fresh)) });
    this.charts.parts.setSeries(partsSeries, { thresholds: [{ y: cfg.parts_to_delay_insert, label: "parts_to_delay_insert" }, { y: cfg.parts_to_throw_insert, label: "parts_to_throw_insert" }] });
    this.charts.busy.setSeries([
      { name: "зайняті потоки", short: "потоки", color: S(1), points: pts(smooth("busy")) },
      { name: "задачі в пулі", short: "задачі", color: S(2), points: pts(smooth("tasks")) },
    ], { thresholds: [{ y: tb.pool.threads, label: "потоків у пулі" }] });
    const accepted = smooth("accepted"), delayed = smooth("delayed"), rejected = smooth("rejected");
    this.charts.inserts.setSeries([
      { name: "прийняті без затримки", short: "без затримки", color: S(1), points: pts(accepted.map((v, i) => Math.max(0, v - delayed[i]))) },
      { name: "затримані", short: "затримані", color: "var(--warning)", points: pts(delayed) },
      { name: "відхилені", short: "відхилені", color: "var(--critical)", points: pts(rejected) },
    ]);
    const merged = smooth("merged", 60), inserted = smooth("inserted", 60);
    this.charts.wa.setSeries([{ name: "підсилення записів за хвилину", color: S(1), points: pts(merged.map((m, i) => (inserted[i] ? m / inserted[i] : null))) }]);
  }
}
