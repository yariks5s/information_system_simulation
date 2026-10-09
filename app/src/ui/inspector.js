// What is selected (a part or a merge task) and why the selector chose the last merge.

import { el, bytes, clock, duration, INT, NUM2, NUM3, PCT, partsText } from "./dom.js";

const MIB = 1024 * 1024;

function rows(list) {
  return el("dl", { class: "kv" }, ...list.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]));
}

export function findPart(table, id) {
  for (const parts of table.partitions.values()) for (const p of parts) if (p.id === id) return p;
  return null;
}

export class Inspector {
  constructor(root, explainRoot, onPick) {
    this.onPick = onPick;
    this.root = root;
    this.explainRoot = explainRoot;
    this.selection = null;
    this.lastExplainKey = null;
  }

  select(selection) {
    this.selection = selection;
  }

  draw(table) {
    const s = this.selection, now = table.engine.now;
    if (!s) {
      this.root.replaceChildren(el("p", { class: "empty" }, "Клацніть на кусок у дереві або на задачу в пулі, щоб побачити подробиці. Записи журналу теж клікабельні."));
    } else if (s.part != null) {
      const p = findPart(table, s.part);
      if (!p) {
        this.root.replaceChildren(el("p", { class: "empty" }, `Куска №${s.part} вже немає: його поглинуло злиття або видалено партицію.`));
      } else {
        const task = p.merging ? table.pool.tasks.find(t => t.payload.includes(p)) : null;
        const list = [
          ["кусок", `№${p.id}, партиція ${p.partition}`],
          ["рівень злиття", String(p.level)],
          ["розмір", bytes(p.size)],
          ["вставок у куску", `${INT.format(p.blocks)} (блоки ${INT.format(p.minBlock)}–${INT.format(p.maxBlock)})`],
          ["створено", `${duration(now - p.createdAt)} тому`],
          ["стан", task ? `зливається в задачі №${task.id}` : "вільний, чекає селектора"],
        ];
        if (p.origin) list.push(["походження", `злиття ${partsText(p.origin.sources)} рівнів ${[...new Set(p.origin.levels)].sort((a, b) => a - b).join(", ")}, ${duration(p.createdAt - p.origin.assignedAt)}`]);
        else list.push(["походження", "одна вставка"]);
        const body = [el("h3", {}, "Кусок даних"), rows(list)];
        if (task) body.push(el("button", { class: "btn small", type: "button", onclick: () => this.onPick({ task: task.id }) }, `Показати задачу №${task.id}`));
        this.root.replaceChildren(...body);
      }
    } else if (s.task != null) {
      const task = table.pool.tasks.find(t => t.id === s.task);
      if (!task) {
        this.root.replaceChildren(el("p", { class: "empty" }, `Злиття №${s.task} вже завершилось.`));
      } else {
        const remaining = table.pool.remainingNow(task);
        const done = 1 - remaining / task.work;
        const levels = task.payload.map(p => p.level);
        this.root.replaceChildren(el("h3", {}, `Злиття №${task.id}`), rows([
          ["джерела", `${partsText(task.payload.length)}, рівні ${Math.min(...levels)}–${Math.max(...levels)}`],
          ["обсяг", bytes(task.priority)],
          ["робота", `${duration(task.work)} часу потоку`],
          ["виконано", PCT.format(Math.max(0, Math.min(1, done)))],
          ["швидкість", task.rate > 0 ? `${NUM2.format(task.rate)} потоку` : "чекає вільного потоку"],
          ["триває", duration(now - task.createdAt)],
          ["залишилось", task.rate > 0 ? `≈ ${duration(remaining / task.rate)} при поточному розподілі` : "невідомо, задача стоїть"],
        ]), el("p", { class: "note" }, "Джерела виділені в дереві, решту кусків приглушено."));
      }
    }
    this.drawExplain(table);
  }

  drawExplain(table) {
    const x = table.lastSelection, m = table.lastMerge;
    const key = `${x ? x.at + x.outcome : ""}|${m ? m.task : ""}`;
    if (key === this.lastExplainKey) return;
    this.lastExplainKey = key;
    const root = this.explainRoot;
    const status = !x ? "Селектор ще не запускався."
      : x.outcome === "pool_full" ? `Останній запуск (${clock(x.at)}): пул повний, усі ${table.pool.maxTasks} місць зайняті, вибір пропущено.`
      : x.outcome === "disabled" ? `Останній запуск (${clock(x.at)}): злиття вимкнені, max_bytes_to_merge_at_max_space_in_pool = 0.`
      : x.outcome === "nothing" && !x.considered ? `Останній запуск (${clock(x.at)}): немає двох сусідніх вільних кусків у межах розміру злиття; призначувач засинає.`
      : x.outcome === "nothing" ? `Останній запуск (${clock(x.at)}): перевірено ${INT.format(x.considered)} діапазонів, жоден не пройшов умову допуску; призначувач засинає.`
      : `Останній запуск (${clock(x.at)}) призначив злиття №${x.task}.`;
    const out = [el("p", { class: "status-line" }, status)];
    if (!m) { root.replaceChildren(...out); return; }
    out.push(el("h3", {}, `Злиття №${m.task}, ${clock(m.at)}`));
    if (m.tiered) {
      out.push(el("p", {}, `Tiered: перший ряд із ${m.count} сусідніх вільних кусків одного рівня, ${bytes(m.sumSize)}.`));
      root.replaceChildren(...out);
      return;
    }
    const lhs = (m.sumSize + m.count * 5 * MIB) / (m.maxSize + 5 * MIB);
    out.push(el("p", {}, `${partsText(m.count)} у партиції ${m.key}, позиції ${m.begin}–${m.end - 1}, разом ${bytes(m.sumSize)}.`), rows([
      ["умова допуску", `(Σ + k·5 МБ)/(max + 5 МБ) = ${NUM2.format(lhs)} ≥ base′ = ${NUM2.format(m.loweredBase)}`],
      ["base′", `з ${NUM2.format(table.cfg.base)}: наймолодший кусок ${duration(m.minAge)}, у відрізку вільних кусків ${INT.format(m.segmentLength)}`],
      ["оцінка", `(Σ + 5 МБ·k)/(k − 1.9) = ${bytes(m.score)}${m.aligned ? ", знижена за вирівнювання з лівим сусідом" : ""}`],
      ["відкинуто дрібних справа", String(m.trimmed || 0)],
      ["кандидатів", `${INT.format(m.allowed)} допустимих з ${INT.format(m.considered)}`],
      ["межа розміру злиття", `${bytes(m.maxBytes)}, вільних місць у пулі ${m.freeEntries}`],
      ["ліміт довжини діапазону", String(m.maxParts)],
      ["робота злиття", `${NUM3.format(m.work)} с часу потоку`],
    ]));
    root.replaceChildren(...out);
  }
}
