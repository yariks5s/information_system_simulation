import { el, sv, tooltip, NUM3, INT } from "./dom.js";

export const S = i => `var(--series-${i})`;

const drawable = p => p[1] != null && Number.isFinite(p[1]) && Number.isFinite(p[0]);

function niceStep(min, max, count = 5) {
  const span = max - min, step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  return [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= count) || 10 * mag;
}

export function niceTicks(min, max, count = 5) {
  if (!(max > min)) return [min];
  const step = niceStep(min, max, count);
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}

function logTicks(min, max) {
  const ticks = [];
  for (let e = Math.floor(Math.log10(min)); e <= Math.ceil(Math.log10(max)); e++) {
    for (const m of (Math.log10(max / min) < 2.2 ? [1, 2, 5] : [1])) {
      const v = m * Math.pow(10, e);
      if (v >= min * 0.999 && v <= max * 1.001) ticks.push(v);
    }
  }
  return ticks;
}

export class Chart {
  constructor(container, options) {
    this.container = container;
    this.o = options;
    container.replaceChildren();
    this.legend = el("div", { class: "legend" });
    this.svg = sv("svg", { class: "chart", role: "img", "aria-label": options.ariaLabel || "" });
    container.append(this.legend, this.svg);
    this.renderLegend();
    this.render();
    new ResizeObserver(() => this.render()).observe(container);
  }

  setSeries(series, extra = {}) {
    const names = s => s.map(x => x.name).join("|");
    const legendChanged = names(series) !== names(this.o.series);
    Object.assign(this.o, extra, { series });
    if (legendChanged) this.renderLegend();
    this.render();
  }

  renderLegend() {
    const o = this.o;
    this.legend.replaceChildren();
    this.legend.hidden = o.series.length < 2;
    for (const s of o.series) {
      const key = o.mode === "scatter" ? el("span", { class: "swatch", style: "border-radius:50%;background:" + s.color })
                                       : el("span", { class: "line", style: "background:" + s.color });
      this.legend.append(el("span", { class: "key" }, key, s.name));
    }
  }

  scale(axis, lo, hi, a, b) {
    if (axis.log) {
      const l0 = Math.log10(lo), l1 = Math.log10(hi);
      const f = v => a + (Math.log10(Math.max(v, lo * 1e-6)) - l0) / (l1 - l0 || 1) * (b - a);
      f.invert = p => Math.pow(10, l0 + (p - a) / (b - a) * (l1 - l0));
      return f;
    }
    const f = v => a + (v - lo) / (hi - lo || 1) * (b - a);
    f.invert = p => lo + (p - a) / (b - a) * (hi - lo);
    return f;
  }

  extent(axis, values, pad) {
    if (!values.length) return axis.log ? [axis.min ?? 1, axis.max ?? 10] : [axis.min ?? 0, axis.max ?? 1];
    let lo = axis.min != null ? axis.min : Math.min(...values);
    let hi = axis.max != null ? axis.max : Math.max(...values);
    if (axis.log) {
      if (axis.min == null) lo = Math.pow(10, Math.floor(Math.log10(lo) * 4) / 4);
      if (axis.max == null) hi = Math.pow(10, Math.ceil(Math.log10(hi) * 4) / 4);
      return [lo, hi];
    }
    if (!(hi > lo)) hi = lo + 1;
    if (axis.max == null && pad) {
      const step = niceStep(lo, hi * 1.04);
      hi = Math.ceil(hi * 1.04 / step) * step;  // the top tick at or above the largest value
    }
    return [lo, hi];
  }

  yValues() {
    const o = this.o, ys = [];
    for (const s of o.series) for (const p of s.points) if (drawable(p)) ys.push(p[1]);
    for (const s of o.series) if (s.band) for (const b of s.band) if (isFinite(b[2])) ys.push(b[2]);
    const top = ys.length ? Math.max(...ys) : 1;
    for (const t of o.thresholds || []) if (t.y <= top * 1.5) ys.push(t.y);
    return ys;
  }

  render() {
    const o = this.o, svg = this.svg;
    const width = Math.max(260, this.container.clientWidth);
    const height = o.height || 220;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("height", height);
    svg.replaceChildren();
    const xs = [];
    for (const s of o.series) for (const p of s.points) if (drawable(p)) xs.push(p[0]);
    const [x0, x1] = this.extent(o.x, xs, false);
    const [y0, y1] = this.extent(o.y, this.yValues(), true);
    const direct = this.directLabels(width, y0, y1, height);
    const m = { l: 52, r: direct ? 104 : 16, t: 10, b: 38 };
    const X = this.scale(o.x, x0, x1, m.l, width - m.r);
    const Y = this.scale(o.y, y0, y1, height - m.b, m.t);
    Object.assign(this, { X, Y, m, width, height });

    const fmtX = o.x.format || (v => NUM3.format(v));
    const fmtY = o.y.format || (v => NUM3.format(v));
    let lastLabel = null;
    for (const v of (o.y.log ? logTicks(y0, y1) : niceTicks(y0, y1))) {
      const label = fmtY(v);
      if (label === lastLabel) continue;  // an integer format over a short range would repeat labels
      lastLabel = label;
      const y = Math.round(Y(v)) + 0.5;
      svg.append(sv("line", { class: "grid-line", x1: m.l, x2: width - m.r, y1: y, y2: y }));
      svg.append(sv("text", { class: "tick", x: m.l - 8, y: y + 4, "text-anchor": "end" }, label));
    }
    for (const v of (o.x.log ? logTicks(x0, x1) : niceTicks(x0, x1, Math.max(3, Math.floor((width - m.l - m.r) / 64))))) {
      const x = Math.round(X(v)) + 0.5;
      if (x < m.l - 1 || x > width - m.r + 1) continue;
      svg.append(sv("text", { class: "tick", x, y: height - m.b + 16, "text-anchor": "middle" }, fmtX(v)));
    }
    const base = Math.round(Y(y0)) + 0.5;
    svg.append(sv("line", { class: "base-line", x1: m.l, x2: width - m.r, y1: base, y2: base }));
    if (o.x.label) svg.append(sv("text", { class: "axis-label", x: (m.l + width - m.r) / 2, y: height - 4, "text-anchor": "middle" }, o.x.label));

    for (const t of o.thresholds || []) {
      if (t.y < y0 || t.y > y1) continue;
      const y = Math.round(Y(t.y)) + 0.5;
      svg.append(sv("line", { class: "threshold", x1: m.l, x2: width - m.r, y1: y, y2: y }));
      svg.append(sv("text", { class: "threshold-label", x: m.l + 4, y: y - 4 }, t.label));
    }

    const clampY = v => Y(Math.min(y1, Math.max(v, o.y.log ? y0 : -Infinity)));
    for (const s of o.series) {
      if (s.band && s.band.length) {
        const top = s.band.map(b => `${X(b[0])},${clampY(b[2])}`);
        const bottom = s.band.slice().reverse().map(b => `${X(b[0])},${clampY(b[1])}`);
        svg.append(sv("polygon", { points: top.concat(bottom).join(" "), style: `fill:${s.color};opacity:0.12` }));
      }
      const kept = s.points.map((p, i) => [p, i]).filter(([p]) => drawable(p));  // keeps the original index for labels
      const pts = kept.map(([p]) => p);
      if (!pts.length) continue;
      if (o.mode !== "scatter" || s.connect) {
        let d = "", gap = true;  // a missing value starts a new subpath instead of bridging it
        for (const p of s.points) {
          if (!drawable(p)) { gap = true; continue; }
          d += (gap ? "M" : "L") + X(p[0]).toFixed(1) + "," + clampY(p[1]).toFixed(1);
          gap = false;
        }
        svg.append(sv("path", { d, style: `fill:none;stroke:${s.color};stroke-width:2;stroke-linejoin:round;stroke-linecap:round` }));
      }
      if (o.mode === "scatter" || s.markers) {
        for (const p of pts) svg.append(sv("circle", { cx: X(p[0]), cy: Y(p[1]), r: 4.5, style: `fill:${s.color};stroke:var(--surface-1);stroke-width:2` }));
      }
      if (s.labels) {
        const [dx, dy] = s.labelOffset || [7, -6];
        kept.forEach(([p, i]) => { if (s.labels[i] != null) svg.append(sv("text", { class: "point-label", x: X(p[0]) + dx, y: Y(p[1]) + dy }, s.labels[i])); });
      }
    }
    if (direct) for (const d of direct) svg.append(sv("text", { class: "end-label", x: width - m.r + 8, y: d.y + 4 }, d.name));

    this.playheadLine = sv("line", { class: "playhead", y1: m.t, y2: height - m.b, x1: -10, x2: -10 });
    if (o.playhead) svg.append(this.playheadLine);
    this.cross = sv("line", { class: "crosshair", y1: m.t, y2: height - m.b, x1: -10, x2: -10, visibility: "hidden" });
    svg.append(this.cross);
    const hit = sv("rect", { class: "hit", x: m.l, y: m.t, width: Math.max(0, width - m.l - m.r), height: Math.max(0, height - m.t - m.b) });
    svg.append(hit);
    hit.addEventListener("pointermove", e => this.hover(e));
    hit.addEventListener("pointerleave", () => { tooltip.hide(); this.cross.setAttribute("visibility", "hidden"); });
    if (o.onClick) hit.addEventListener("click", e => o.onClick(this.X.invert(this.localX(e))));
    if (this.playheadAt != null) this.setPlayhead(this.playheadAt);
  }

  directLabels(width, y0, y1, height) {
    const o = this.o;
    if (o.mode === "scatter" || o.series.length < 2 || o.series.length > 4 || width < 420) return null;
    const Y = this.scale(o.y, y0, y1, height - 38, 10);
    const ends = [];
    for (const s of o.series) {
      const pts = s.points.filter(drawable);
      if (!pts.length) return null;
      ends.push({ name: s.short || s.name, y: Y(pts[pts.length - 1][1]) });
    }
    ends.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) return null;  // labels collide: legend and tooltip only
    return ends;
  }

  localX(e) {
    const r = this.svg.getBoundingClientRect();
    return (e.clientX - r.left) * this.width / r.width;
  }

  hover(e) {
    const o = this.o, px = this.localX(e);
    const r = this.svg.getBoundingClientRect();
    const py = (e.clientY - r.top) * this.height / r.height;
    const fmt = o.valueFormat || (v => NUM3.format(v));
    if (o.mode === "scatter") {
      let best = null;
      o.series.forEach(s => s.points.forEach((p, i) => {
        const d = Math.hypot(this.X(p[0]) - px, this.Y(p[1]) - py);
        if (d < 28 && (!best || d < best.d)) best = { d, s, i };
      }));
      if (!best) { tooltip.hide(); return; }
      tooltip.show(e.clientX, e.clientY, best.s.name + (best.s.labels ? ", " + best.s.labels[best.i] : ""), o.scatterRows(best.s, best.i));
      return;
    }
    let snap = null;
    const rows = [];
    for (const s of o.series) {
      let bi = -1, bd = Infinity;
      s.points.forEach((p, i) => { const d = Math.abs(this.X(p[0]) - px); if (d < bd && p[1] != null) { bd = d; bi = i; } });
      if (bi < 0) continue;
      const p = s.points[bi];
      if (snap == null) snap = p[0];
      rows.push({ name: s.name, color: s.color, value: fmt(p[1], s, bi) });
    }
    if (snap == null) return;
    const x = this.X(snap);
    this.cross.setAttribute("x1", x); this.cross.setAttribute("x2", x); this.cross.setAttribute("visibility", "visible");
    tooltip.show(e.clientX, e.clientY, o.tooltipTitle ? o.tooltipTitle(snap) : (o.x.format || NUM3.format)(snap), rows);
  }

  setPlayhead(x) {
    this.playheadAt = x;
    if (!this.X) return;
    const px = this.X(x);
    this.playheadLine.setAttribute("x1", px);
    this.playheadLine.setAttribute("x2", px);
  }
}

export class Bars {
  constructor(container, options) {
    this.container = container;
    this.o = options;
    container.replaceChildren();
    this.svg = sv("svg", { class: "chart" });
    container.append(this.svg);
    this.render();
    new ResizeObserver(() => this.render()).observe(container);
  }

  render() {
    const o = this.o, svg = this.svg;
    const width = Math.max(200, this.container.clientWidth);
    const band = 30, m = { l: o.labelWidth || 150, r: 44, t: 6, b: 24 };
    const height = m.t + m.b + band * o.values.length;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("height", height);
    svg.replaceChildren();
    const lo0 = Math.min(0, ...o.values), hi0 = Math.max(0, ...o.values), pad = 0.22 * (hi0 - lo0 || 1);
    const lo = lo0 < 0 ? lo0 - pad : 0, hi = hi0 > 0 ? hi0 + pad * 0.3 : 0;
    const X = v => m.l + (v - lo) / (hi - lo || 1) * (width - m.l - m.r);
    for (const v of niceTicks(lo, hi, 4)) {
      const x = Math.round(X(v)) + 0.5;
      svg.append(sv("line", { class: "grid-line", x1: x, x2: x, y1: m.t, y2: height - m.b }));
      svg.append(sv("text", { class: "tick", x, y: height - 6, "text-anchor": "middle" }, NUM3.format(v)));
    }
    o.values.forEach((v, i) => {
      const y = m.t + i * band + (band - 18) / 2;
      const x0 = X(Math.min(0, v)), x1 = X(Math.max(0, v));
      const w = Math.max(1, x1 - x0), r = Math.min(4, w);
      const d = v >= 0
        ? `M${x0},${y} H${x1 - r} Q${x1},${y} ${x1},${y + r} V${y + 18 - r} Q${x1},${y + 18} ${x1 - r},${y + 18} H${x0} Z`
        : `M${x1},${y} H${x0 + r} Q${x0},${y} ${x0},${y + r} V${y + 18 - r} Q${x0},${y + 18} ${x0 + r},${y + 18} H${x1} Z`;
      svg.append(sv("path", { d, style: `fill:${o.color}` }));
      svg.append(sv("text", { class: "tick", x: m.l - 8, y: y + 13, "text-anchor": "end", style: "fill:var(--text-secondary);font-size:12px" }, o.labels[i]));
      svg.append(sv("text", { class: "end-label", x: v >= 0 ? x1 + 6 : x0 - 6, y: y + 13, "text-anchor": v >= 0 ? "start" : "end" }, (v > 0 ? "+" : "") + NUM3.format(v)));
      const hit = sv("rect", { class: "hit", x: m.l, y: y - 6, width: Math.max(0, width - m.l - m.r), height: 30 });
      hit.addEventListener("pointermove", e => tooltip.show(e.clientX, e.clientY, o.labels[i], [{ name: o.name, value: (v > 0 ? "+" : "") + NUM3.format(v) }]));
      hit.addEventListener("pointerleave", () => tooltip.hide());
      svg.append(hit);
    });
    const zero = Math.round(X(0)) + 0.5;
    svg.append(sv("line", { class: "base-line", x1: zero, x2: zero, y1: m.t, y2: height - m.b }));
  }
}

export function table(columns, rows) {
  const t = el("table", { class: "data" });
  t.append(el("thead", {}, el("tr", {}, ...columns.map(c => el("th", {}, c)))));
  const body = el("tbody");
  for (const r of rows) body.append(el("tr", {}, ...r.map(v => el("td", {}, String(v)))));
  t.append(body);
  return el("div", { class: "table-wrap" }, t);
}

export function card(title, sub, { tableView, wide } = {}) {
  const body = el("div");
  const head = el("div", { class: "card-head" }, el("div", {}, el("h2", {}, title), sub ? el("p", { class: "sub" }, sub) : null));
  const c = el("div", { class: "card", style: wide ? "grid-column: 1 / -1" : "" }, head, body);
  if (tableView) {
    const holder = el("div", { hidden: true });
    const button = el("button", { class: "toggle-table", type: "button" }, "Таблиця");
    button.addEventListener("click", () => {
      if (!holder.childNodes.length) holder.append(tableView());
      holder.hidden = !holder.hidden;
      button.textContent = holder.hidden ? "Таблиця" : "Сховати таблицю";
    });
    head.append(button);
    c.append(holder);
  }
  return { card: c, body };
}

export const ci = ([mean, half]) => (half ? `${NUM3.format(mean)} ± ${NUM3.format(half)}` : NUM3.format(mean));
export const intFormat = v => INT.format(v);
