import { el, bytes, PCT, partsText } from "./dom.js";

const MAX_SHOWN = 64;

export class PoolView {
  constructor(root, { onPick }) {
    this.root = root;
    this.onPick = onPick;
    this.slotOf = new Map();
    this.slots = [];
    this.nodes = [];
    this.more = el("div", { class: "pool-more", hidden: true });
    this.grid = el("div", { class: "pool" });
    root.append(this.grid, this.more);
    this.selected = null;
  }

  reset() {
    this.slotOf.clear();
    this.slots = [];
    this.selected = null;
  }

  // a task keeps its slot until it finishes, so the picture does not jump
  sync(pool) {
    const live = new Set(pool.tasks.map(t => t.id));
    for (const [id, slot] of this.slotOf) if (!live.has(id)) { this.slotOf.delete(id); this.slots[slot] = null; }
    for (const t of pool.tasks) {
      if (this.slotOf.has(t.id)) continue;
      let slot = this.slots.indexOf(null);
      if (slot < 0) slot = this.slots.length;
      this.slots[slot] = t.id;
      this.slotOf.set(t.id, slot);
    }
    while (this.slots.length > pool.maxTasks && this.slots[this.slots.length - 1] == null) this.slots.pop();
  }

  draw(pool) {
    this.sync(pool);
    const count = Math.max(pool.maxTasks, this.slots.length);
    const shown = Math.min(count, MAX_SHOWN);
    while (this.nodes.length < shown) {
      const i = this.nodes.length;
      const node = el("button", { class: "slot free", type: "button" }, el("span", { class: "meta" }, el("span", {}, "вільно"), el("span", {}, "")), el("span", { class: "bar" }, el("span", { style: "width:0" })));
      node.addEventListener("click", () => { const id = this.slots[i]; if (id != null) this.onPick({ task: id }); });
      this.nodes.push(node);
      this.grid.append(node);
    }
    this.nodes.forEach((n, i) => { n.hidden = i >= shown; if (n.hidden) n.className = "slot free"; });
    const byId = new Map(pool.tasks.map(t => [t.id, t]));
    for (let i = 0; i < shown; i++) {
      const node = this.nodes[i], id = this.slots[i], task = id != null ? byId.get(id) : null;
      const [label, pct] = node.firstElementChild.children;
      const fill = node.lastElementChild.firstElementChild;
      if (!task) {
        node.className = "slot free" + (i >= pool.maxTasks ? " over" : "");
        node.title = "";
        label.textContent = "вільно";
        pct.textContent = "";
        fill.style.width = "0";
        node.disabled = true;
        continue;
      }
      node.disabled = false;
      const done = Math.max(0, Math.min(1, 1 - pool.remainingNow(task) / task.work));
      node.className = "slot" + (task.rate > 0 ? "" : " waiting") + (task.id === this.selected ? " selected" : "");
      label.textContent = `${task.payload.length} шт · ${bytes(task.priority)}`;
      node.title = `Злиття №${task.id}: ${partsText(task.payload.length)}, ${bytes(task.priority)}`;
      pct.textContent = PCT.format(done);
      fill.style.width = (100 * done) + "%";
    }
    const hidden = pool.tasks.filter(t => this.slotOf.get(t.id) >= shown).length;
    this.more.hidden = count <= shown;
    this.more.textContent = `Показано ${shown} з ${count} місць; ще ${hidden} задач не вмістились.`;
  }
}
