// The parts of every partition as rectangles: the row is the merge level, the horizontal position is which
// inserts a part holds, on a log scale from the newest inserts at the right to the oldest at the left.

import { cssVar, tooltip, bytes, duration, INT, plural } from "./dom.js";

const MAX_BANDS = 8;  // newest partitions shown; with "keep all" the canvas would otherwise grow without limit

export class PartsTree {
  constructor(canvas, { onPick }) {
    this.canvas = canvas;
    this.onPick = onPick;
    this.rects = [];
    this.selectedPart = null;
    this.highlightTask = null;
    this.maxBands = 1;
    this.maxLevel = 4;
    canvas.addEventListener("pointermove", e => this.hover(e));
    canvas.addEventListener("pointerleave", () => tooltip.hide());
    canvas.addEventListener("click", e => {
      const hit = this.hit(e);
      this.onPick(hit ? { part: hit.p.id } : null);
    });
  }

  reset() {
    this.maxBands = 1;
    this.maxLevel = 4;
    this.selectedPart = null;
    this.highlightTask = null;
  }

  layout(width, table) {
    this.maxBands = Math.min(MAX_BANDS, Math.max(this.maxBands, table.partitions.size));
    for (const parts of table.partitions.values()) for (const p of parts) if (p.level > this.maxLevel) this.maxLevel = p.level;
    const levels = Math.min(this.maxLevel, 11) + 1;
    const bands = this.maxBands, gap = 3, bandPad = 18;
    const rowH = Math.max(9, Math.min(26, Math.floor((340 - bands * bandPad) / (bands * levels) - gap)));
    const bandH = levels * (rowH + gap) + bandPad;
    return { left: 96, right: width - 12, top: 6, rowH, gap, levels, bandH, bands, height: 6 + bands * bandH + 30 };
  }

  draw(table) {
    const canvas = this.canvas;
    const width = canvas.parentElement.clientWidth - 36;
    if (width <= 0) return;
    const L = this.layout(width, table);
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(L.height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(L.height * dpr);
      canvas.style.height = L.height + "px";
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, L.height);
    const colors = [0, 1, 2, 3, 4].map(i => cssVar(`--level-${i}`));
    const active = cssVar("--series-2"), ink = cssVar("--text-primary"), muted = cssVar("--text-muted");
    const grid = cssVar("--grid"), secondary = cssVar("--text-secondary");
    const last = table.lastBlock, maxAge = Math.max(10, last);
    const lg = Math.log10(1 + maxAge);
    const X = age => L.left + (L.right - L.left) * (1 - Math.log10(1 + age) / lg);
    const task = this.highlightTask != null ? table.pool.tasks.find(t => t.id === this.highlightTask) : null;
    const sources = task ? new Set(task.payload) : null;
    this.rects = [];
    ctx.font = "11px system-ui, -apple-system, 'Segoe UI', sans-serif";
    ctx.textBaseline = "middle";
    const keys = [...table.partitions.keys()].sort((a, b) => b - a).slice(0, MAX_BANDS);  // newest on top
    keys.forEach((key, b) => {
      const top = L.top + b * L.bandH;
      const bottom = top + L.levels * (L.rowH + L.gap);
      const parts = table.partitions.get(key);
      ctx.fillStyle = secondary;
      ctx.textAlign = "left";
      ctx.fillText(table.cfg.partition_seconds || table.partitions.size > 1 ? `партиція ${key}` : "таблиця", 0, top + 7);
      ctx.fillStyle = muted;
      ctx.fillText(`${INT.format(parts.length)} шт.`, 0, top + 21);
      ctx.textAlign = "right";
      ctx.fillStyle = muted;
      for (let lv = 0; lv < L.levels; lv++) {
        const y = bottom - (lv + 1) * (L.rowH + L.gap) + L.gap;
        if (L.rowH >= 9) ctx.fillText(lv === L.levels - 1 && this.maxLevel > 11 ? `${lv}+` : String(lv), L.left - 8, y + L.rowH / 2);
      }
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(L.left, Math.round(bottom) + 0.5);
      ctx.lineTo(L.right, Math.round(bottom) + 0.5);
      ctx.stroke();
      for (const p of parts) {
        const lv = Math.min(p.level, L.levels - 1);
        const y = bottom - (lv + 1) * (L.rowH + L.gap) + L.gap;
        const x0 = X(last - p.minBlock + 1), x1 = X(last - p.maxBlock);
        const w = x1 - x0;
        const drawW = w > 3 ? w - 1 : Math.max(w, 0.8);  // 1px surface gap between neighbours
        ctx.globalAlpha = sources && !sources.has(p) ? 0.28 : 1;
        ctx.fillStyle = colors[Math.min(p.level, 4)];
        ctx.fillRect(x0, y, drawW, L.rowH);
        if (p.level === 0 && drawW > 2 && !p.merging) {
          // the lightest level is below 3:1 against the surface: an outline keeps it visible
          ctx.strokeStyle = colors[2];
          ctx.lineWidth = 1;
          ctx.strokeRect(x0 + 0.5, y + 0.5, drawW - 1, L.rowH - 1);
        }
        if (p.merging) {
          ctx.strokeStyle = active;
          ctx.lineWidth = sources && sources.has(p) ? 2.5 : 1.5;
          ctx.strokeRect(x0 + 0.75, y + 0.75, Math.max(0.5, drawW - 1.5), L.rowH - 1.5);
        }
        if (p.id === this.selectedPart) {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = ink;
          ctx.lineWidth = 2;
          ctx.strokeRect(x0 - 1.5, y - 1.5, Math.max(3, drawW + 3), L.rowH + 3);
        }
        this.rects.push({ x0, x1: x0 + Math.max(drawW, 4), y, h: L.rowH, p });
      }
      ctx.globalAlpha = 1;
    });
    const axisY = L.top + L.bands * L.bandH + 4;
    ctx.fillStyle = muted;
    ctx.textBaseline = "top";
    ctx.textAlign = "center";
    for (const age of [0, 10, 100, 1000, 10000, 100000, 1000000]) {
      if (age > maxAge) break;
      ctx.fillText(age === 0 ? "щойно" : INT.format(age), Math.min(L.right - 14, Math.max(L.left + 10, X(age))), axisY);
    }
    ctx.textAlign = "left";
    ctx.fillStyle = secondary;
    ctx.fillText("вставок тому", L.left, axisY + 14);
    const hidden = table.partitions.size - keys.length;
    if (hidden > 0) {
      ctx.textAlign = "right";
      ctx.fillText(`ще ${hidden} ${plural(hidden, "старша партиція", "старші партиції", "старших партицій")} не показано`, L.right, axisY + 14);
    }
    this.table = table;
  }

  hit(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let best = null;
    for (const q of this.rects) {
      if (y < q.y - 1 || y > q.y + q.h + 1) continue;
      if (x >= q.x0 - 2 && x <= q.x1 + 2) {
        const d = Math.abs(x - (q.x0 + q.x1) / 2);
        if (!best || d < best.d) best = { ...q, d };
      }
    }
    return best;
  }

  hover(e) {
    const hit = this.hit(e);
    if (!hit) { tooltip.hide(); this.canvas.style.cursor = "default"; return; }
    this.canvas.style.cursor = "pointer";
    const p = hit.p, now = this.table.engine.now;
    tooltip.show(e.clientX, e.clientY, `Кусок №${p.id}, рівень ${p.level}`, [
      { name: "розмір", value: bytes(p.size) },
      { name: "вставок у куску", value: INT.format(p.blocks) },
      { name: "вік", value: duration(Math.max(0, now - p.createdAt)) },
      { name: "стан", value: p.merging ? "зливається" : "вільний" },
      { name: "", value: "клацніть, щоб дослідити" },
    ]);
  }
}
