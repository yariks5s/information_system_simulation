// The event log: what the model did, in words. Throttling is summed per second of model time so that a burst
// of delayed inserts is one line, not thousands.

import { el, bytes, clock, duration, INT, NUM2, partsText } from "./dom.js";

export const KINDS = {
  merge: "злиття",
  throttle: "гальмування",
  partition: "партиції",
  assignee: "призначувач",
  insert: "вставки",
};

export class EventLog {
  constructor(root, onPick) {
    this.root = root;
    this.onPick = onPick;
    this.entries = [];
    this.enabled = new Set(["merge", "throttle", "partition"]);
    this.throttleSecond = null;
    this.dirty = true;
    const filters = el("div", { class: "log-filters" });
    for (const [kind, name] of Object.entries(KINDS)) {
      const box = el("input", { type: "checkbox", checked: this.enabled.has(kind) });
      box.addEventListener("change", () => { box.checked ? this.enabled.add(kind) : this.enabled.delete(kind); this.dirty = true; this.render(); });
      filters.append(el("label", { class: "check" }, box, name));
    }
    this.list = el("ol", { class: "log", "aria-live": "off" });
    root.append(filters, this.list);
  }

  clear() {
    this.entries = [];
    this.throttleSecond = null;
    this.dirty = true;
  }

  push(t, kind, text, ref = null) {
    this.entries.push({ t, kind, text, ref });
    if (this.entries.length > 400) this.entries.shift();
    this.dirty = true;
  }

  observe(type, t, ...data) {
    if (type === "assign") {
      const [task, found] = data;
      const sizes = task.payload.map(p => p.level);
      const lo = Math.min(...sizes), hi = Math.max(...sizes);
      const why = found.tiered ? `${found.count} сусідніх кусків одного рівня` : `base′ = ${NUM2.format(found.loweredBase)}, оцінка ${bytes(found.score)}`;
      this.push(t, "merge", `Призначено злиття №${task.id}: ${partsText(task.payload.length)} рівнів ${lo === hi ? lo : lo + "–" + hi}, ${bytes(task.priority)}; ${why}`, { task: task.id });
    } else if (type === "merged") {
      const [task, part] = data;
      this.push(t, "merge", `Злиття №${task.id} завершилось за ${duration(t - task.createdAt)}: новий кусок рівня ${part.level}, ${bytes(part.size)}`, { part: part.id });
    } else if (type === "arrival") {
      const delay = data[0];
      if (delay === null || delay > 0) {
        const second = Math.floor(t);
        let e = this.throttleSecond;
        if (!e || e.second !== second) {
          e = this.throttleSecond = { second, delayed: 0, rejected: 0, maxDelay: 0, entry: null };
          e.entry = { t, kind: "throttle", text: "", ref: null };
          this.entries.push(e.entry);
          if (this.entries.length > 400) this.entries.shift();
        }
        if (delay === null) e.rejected++;
        else { e.delayed++; e.maxDelay = Math.max(e.maxDelay, delay); }
        const parts = [];
        if (e.delayed) parts.push(`затримано ${INT.format(e.delayed)} (до ${INT.format(e.maxDelay)} мс)`);
        if (e.rejected) parts.push(`відхилено ${INT.format(e.rejected)} з TOO_MANY_PARTS`);
        e.entry.text = "Вставки за секунду: " + parts.join(", ");
        this.dirty = true;
      }
    } else if (type === "insert") {
      const part = data[0];
      this.push(t, "insert", `Вставка: новий кусок ${bytes(part.size)} у партиції ${part.partition}`, { part: part.id });
    } else if (type === "sleep") {
      this.push(t, "assignee", `Призначувач не знайшов злиття і заснув на ${duration(data[0])}`);
    } else if (type === "rotate") {
      this.push(t, "partition", `Почалась партиція ${data[0]}`);
    } else if (type === "drop") {
      this.push(t, "partition", `Партицію ${data[0]} видалено разом з ${partsText(data[1])}`);
    }
  }

  render() {
    if (!this.dirty) return;
    this.dirty = false;
    const shown = [];
    for (let i = this.entries.length - 1; i >= 0 && shown.length < 120; i--) {
      const e = this.entries[i];
      if (this.enabled.has(e.kind)) shown.push(e);
    }
    this.list.replaceChildren(...shown.map(e => {
      const item = el("li", { class: "log-" + e.kind }, el("span", { class: "log-time" }, clock(e.t)), el("span", { class: "log-kind" }, KINDS[e.kind]), el("span", {}, e.text));
      if (e.ref) {
        item.classList.add("pick");
        item.addEventListener("click", () => this.onPick(e.ref));
      }
      return item;
    }));
  }
}
