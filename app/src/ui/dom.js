// text always goes in as text nodes, never as html

const SVG_NS = "http://www.w3.org/2000/svg";

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "style") node.style.cssText = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  return node;
}

export function sv(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export const NUM = new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 1 });
export const NUM2 = new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 2 });
export const NUM3 = new Intl.NumberFormat("uk-UA", { maximumSignificantDigits: 3 });
export const INT = new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 0 });
export const PCT = new Intl.NumberFormat("uk-UA", { style: "percent", maximumFractionDigits: 1 });

export function bytes(b) {
  if (b >= 1e12) return NUM.format(b / 1e12) + " ТБ";
  if (b >= 1e9) return NUM.format(b / 1e9) + " ГБ";
  if (b >= 1e6) return NUM.format(b / 1e6) + " МБ";
  if (b >= 1e3) return NUM.format(b / 1e3) + " КБ";
  return INT.format(b) + " Б";
}

export function clock(seconds) {
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = Math.floor(seconds % 60);
  const mm = String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  return h ? h + ":" + mm : mm;
}

export function duration(seconds) {
  if (!isFinite(seconds)) return "∞";
  if (Math.round(seconds * 1000) < 1000) return INT.format(seconds * 1000) + " мс";
  if (seconds < 59.95) return NUM.format(seconds) + " с";
  const total = Math.round(seconds);  // rounded once, so 119.6 s is 2 min 0 s, not 1 min 60 s
  if (total < 3600) return Math.floor(total / 60) + " хв " + (total % 60) + " с";
  return NUM.format(seconds / 3600) + " год";
}

export function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

export const partsText = n => `${INT.format(n)} ${plural(n, "кусок", "куски", "кусків")}`;

export const tooltip = {
  node: null,
  show(x, y, title, rows) {
    const n = this.node || (this.node = document.getElementById("tooltip"));
    n.replaceChildren();
    if (title) n.append(el("div", { class: "title" }, title));
    for (const r of rows) {
      const name = el("span", { class: "name" });
      if (r.color) name.append(el("i", { style: "background:" + r.color }));
      name.append(r.name);
      n.append(el("div", { class: "row" }, name, el("strong", {}, r.value)));
    }
    n.hidden = false;
    const w = n.offsetWidth, h = n.offsetHeight;
    let left = x + 14, top = y + 14;
    if (left + w > window.innerWidth - 8) left = x - w - 14;
    if (top + h > window.innerHeight - 8) top = y - h - 14;
    n.style.left = Math.max(8, left) + "px";
    n.style.top = Math.max(8, top) + "px";
  },
  hide() { if (this.node) this.node.hidden = true; },
};
