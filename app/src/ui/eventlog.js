// The event log: what the model did, in words. Throttling is summed per second of model time so that a burst
// of delayed inserts is one line, not thousands. Each model has its own entries (newState); the log shows one of them.
// Only the kinds that are switched on are kept, so the hidden per-insert lines do not push the others out.

import { el, bytes, clock, duration, INT, NUM2, partsText } from "./dom.js";

export const KINDS = {
  merge: "злиття",
  throttle: "гальмування",
  partition: "партиції",
  assignee: "призначувач",
  insert: "вставки",
  disk: "диск",
  action: "дії",
};

export class EventLog {
  constructor(root, onPick) {
    this.root = root;
    this.onPick = onPick;
    this.enabled = new Set(["merge", "throttle", "partition", "disk", "action"]);
    this.s = EventLog.newState();
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

  static newState() {
    return { entries: [], throttleSecond: null, diskSecond: null, cancelled: null };
  }

  show(state) {
    this.s = state;
    this.dirty = true;
  }

  push(state, t, kind, text, ref = null) {
    if (!this.enabled.has(kind)) return;
    add(state, { t, kind, text, ref });
    this.dirty = true;
  }

  observe(state, type, t, ...data) {
    this.dirty = true;
    if (type === "assign") {
      const [task, found] = data;
      const sizes = task.payload.map(p => p.level);
      const lo = Math.min(...sizes), hi = Math.max(...sizes);
      const why = found.tiered ? `${found.count} сусідніх кусків одного рівня` : `base′ = ${NUM2.format(found.loweredBase)}, оцінка ${bytes(found.score)}`;
      this.push(state, t, "merge", `Призначено злиття №${task.id}: ${partsText(task.payload.length)} рівнів ${lo === hi ? lo : lo + "–" + hi}, ${bytes(task.priority)}; ${why}`, { task: task.id });
    } else if (type === "merged") {
      const [task, part] = data;
      this.push(state, t, "merge", `Злиття №${task.id} завершилось за ${duration(t - task.createdAt)}: новий кусок рівня ${part.level}, ${bytes(part.size)}`, { part: part.id });
    } else if (type === "arrival") {
      const delay = data[0];
      if ((delay === null || delay > 0) && this.enabled.has("throttle")) {
        const second = Math.floor(t);
        let e = state.throttleSecond;
        if (!e || e.second !== second) {
          e = state.throttleSecond = { second, delayed: 0, rejected: 0, maxDelay: 0, entry: { t, kind: "throttle", text: "", ref: null } };
          add(state, e.entry);
        }
        if (delay === null) e.rejected++;
        else { e.delayed++; e.maxDelay = Math.max(e.maxDelay, delay); }
        const parts = [];
        if (e.delayed) parts.push(`затримано ${INT.format(e.delayed)} (до ${INT.format(e.maxDelay)} мс)`);
        if (e.rejected) parts.push(`відхилено ${INT.format(e.rejected)} з TOO_MANY_PARTS`);
        e.entry.text = "Вставки за секунду: " + parts.join(", ");
      }
    } else if (type === "nospace" && this.enabled.has("disk")) {
      // summed per second, like throttling
      const second = Math.floor(t);
      let e = state.diskSecond;
      if (!e || e.second !== second) {
        e = state.diskSecond = { second, count: 0, entry: { t, kind: "disk", text: "", ref: null } };
        add(state, e.entry);
      }
      e.count++;
      e.entry.text = `Вставки за секунду: відхилено ${INT.format(e.count)} з NOT_ENOUGH_SPACE, бракує місця для нового куска`;
    } else if (type === "insert") {
      const part = data[0];
      this.push(state, t, "insert", `Вставка: новий кусок ${bytes(part.size)} у партиції ${part.partition}`, { part: part.id });
    } else if (type === "sleep") {
      this.push(state, t, "assignee", `Призначувач не знайшов злиття і заснув на ${duration(data[0])}`);
    } else if (type === "rotate") {
      this.push(state, t, "partition", `Почалась партиція ${data[0]}`);
    } else if (type === "drop") {
      this.push(state, t, "partition", `Партицію ${data[0]} видалено разом з ${partsText(data[1])}; її куски лежать на диску ще old_parts_lifetime`);
    } else if (type === "cancel" && this.enabled.has("partition")) {
      // DROP PARTITION cancels every running merge at once: one line per drop
      let e = state.cancelled;
      if (!e || e.t !== t) {
        e = state.cancelled = { t, count: 0, entry: { t, kind: "partition", text: "", ref: null } };
        add(state, e.entry);
      }
      e.count++;
      e.entry.text = `DROP PARTITION скасував ${INT.format(e.count)} ${e.count === 1 ? "злиття" : "злиттів"}, що йшли в пулі; їхня робота втрачена`;
    }
  }

  render() {
    // a list rebuilt under the pointer would swallow clicks
    if (!this.dirty || this.list.matches(":hover")) return;
    this.dirty = false;
    const shown = [];
    const entries = this.s.entries;
    for (let i = entries.length - 1; i >= 0 && shown.length < 120; i--) {
      const e = entries[i];
      if (this.enabled.has(e.kind)) shown.push(e);
    }
    this.list.replaceChildren(...shown.map(e => {
      const item = el("li", { class: "log-" + e.kind }, el("span", { class: "log-time" }, clock(e.t)), el("span", { class: "log-kind" }, KINDS[e.kind]), el("span", {}, e.text));
      if (e.ref) {
        item.classList.add("pick");
        item.tabIndex = 0;
        item.setAttribute("role", "button");
        item.addEventListener("click", () => this.onPick(e.ref));
        item.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); this.onPick(e.ref); } });
      }
      return item;
    }));
  }
}

function add(state, entry) {
  state.entries.push(entry);
  if (state.entries.length > 400) state.entries.shift();
}
