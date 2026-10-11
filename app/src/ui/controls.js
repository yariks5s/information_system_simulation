// The parameter panel: every control writes to the running model at once, and presets restart it.

import { el, bytes, INT, NUM, NUM2 } from "./dom.js";
import { AUX } from "../data/calibration.js";

const MB = 1e6, MIB = 1024 * 1024, GIB = 1024 * MIB;

export const PRESETS = {
  normal: { title: "Звичайна робота", text: "100 вставок по 3.6 МБ за секунду, пул 16 потоків. Злиття встигають: кусків близько сотні, пул зайнятий наполовину.",
            config: { insert_rate: 100 } },
  saturated: { title: "Насичений пул", text: "260 вставок/с. Усі 16 потоків зайняті, кусків стає більше, а злиття ширшими: система обмінює кількість кусків на менше підсилення записів.",
               config: { insert_rate: 260 } },
  burst: { title: "Сплеск ×3", text: "150 вставок/с, а на другій хвилині потік утричі зростає на 3 хвилини. Під час сплеску кусків стає в рази більше, вмикається гальмування, а після сплеску система довго розбирає хвіст.",
           config: { insert_rate: 150 }, actions: [[120, "burst", 3, 180]] },
  feedback: { title: "Гальмування як зворотний зв'язок", text: "35 замкнених клієнтів пропонують 350 вставок/с, більше за пропускну здатність злиттів. Пороги знижено до 300 і 900, обмеження за середнім розміром куска вимкнене. Затримки сповільнюють клієнтів, і кусків стає рівно стільки, скільки дозволяє поріг.",
              config: { arrivals: "closed", clients: 35, think_time: 0.1, parts_to_delay_insert: 300, parts_to_throw_insert: 900, max_avg_part_size_for_too_many_parts: 0 } },
  small: { title: "Дрібні вставки, малий пул", text: "600 вставок по 0.29 МБ за секунду і лише 4 потоки. Той самий потік даних, що й у звичайній роботі, але дрібними пакетами: пул насичується, кусків у кілька разів більше.",
           config: { insert_rate: 600, insert_bytes_mean: 0.29 * MB, threads: 4 } },
  partitions: { title: "Ротація партицій", text: "150 вставок/с, нова партиція кожні 2 модельні хвилини, зберігаються 3 найновіші, 10% вставок запізнюються в попередню партицію. Злиття не перетинають межу партиції, старі партиції видаляються цілком.",
                 config: { insert_rate: 150, partition_seconds: 120, retention_partitions: 3, late_insert_fraction: 0.1 } },
  tiered: { title: "Деградація tiered-селектора", text: "Базовий tiered-селектор з base 2 зливає лише сусідні куски одного рівня. Куски різних рівнів перемішуються і блокують одне одного: пул майже простоює, а кусків стає дедалі більше.",
            config: { insert_rate: 150, selector: "tiered", base: 2 } },
  projection: { title: "Проєкція", text: "100 вставок/с у таблицю з проєкцією: кожен кусок на диску вдвічі більший, а злиття вдвічі довше. Порівняйте зайнятість пулу зі звичайною роботою.",
                config: { insert_rate: 100, aux: [AUX.projection] } },
  disk: { title: "Диск заповнюється", text: "100 вставок/с, для таблиці 1.5 ТБ. Куски, що вже злились, ще 8 хвилин лежать на диску (old_parts_lifetime) і займають понад половину місця. Злиття стартує, лише коли вільно вдвічі більше за його джерела, тому з 15-ї хвилини межа розміру злиття падає. Коли місце закінчується, вставки відхиляються з NOT_ENOUGH_SPACE, злиття не вміщаються, кусків стає дедалі більше, і врешті вмикається гальмування.",
          config: { insert_rate: 100, disk_bytes: 1.5e12 } },
  stopped: { title: "Без злиттів", text: "Злиття вимкнені (max_bytes_to_merge_at_max_space_in_pool = 0), пороги гальмування знижено до 200 і 400: кусків стає дедалі більше, поки вставки спершу гальмуються, а потім відхиляються.",
             config: { insert_rate: 50, max_bytes_at_max_space: 0, parts_to_delay_insert: 200, parts_to_throw_insert: 400 } },
};

const log = (min, max) => ({
  toSlider: v => Math.log(v / min) / Math.log(max / min) * 1000,
  fromSlider: s => min * Math.pow(max / min, s / 1000),
});
const lin = (min, max) => ({ toSlider: v => (v - min) / (max - min) * 1000, fromSlider: s => min + (max - min) * s / 1000 });

const FIELDS = [
  { group: "Вхідний потік" },
  { key: "arrivals", label: "Тип входу", type: "seg", options: [["open", "відкритий"], ["closed", "замкнений"]],
    hint: "Відкритий: вставки приходять незалежно від стану системи. Замкнений: N клієнтів, кожен чекає завершення своєї вставки." },
  { key: "insert_rate", label: "Інтенсивність", type: "range", ...log(1, 2000), round: v => (v < 10 ? Math.round(v * 10) / 10 : Math.round(v)),
    format: v => `${NUM.format(v)} вставок/с`, visible: c => c.arrivals === "open" },
  { key: "clients", label: "Клієнти N", type: "range", ...lin(1, 200), round: Math.round, format: v => INT.format(v), visible: c => c.arrivals === "closed" },
  { key: "think_time", label: "Час думання Z", type: "range", ...log(0.01, 10), round: v => Math.round(v * 1000) / 1000, format: v => `${NUM2.format(v)} с`,
    visible: c => c.arrivals === "closed" },
  { key: "insert_bytes_mean", label: "Розмір вставки", type: "range", ...log(0.05 * MB, 500 * MB), round: v => Math.round(v / 1e4) * 1e4, format: v => bytes(v) },
  { key: "insert_bytes_cv", label: "Розкид розміру (cv)", type: "range", ...lin(0, 2), round: v => Math.round(v * 20) / 20, format: v => NUM2.format(v) },
  { actions: [["burst", "Сплеск"]], visible: c => c.arrivals === "open",
    hint: "Сплеск додає до відкритого потоку окремий пуасонівський потік, тож базові вставки лишаються тими самими." },
  { actions: [["pause", "Зупинити вставки"]] },

  { group: "Пул фонових задач" },
  { key: "threads", label: "Потоки (background_pool_size)", type: "range", ...lin(1, 64), round: Math.round, format: v => INT.format(v) },
  { key: "concurrency_ratio", label: "Задач на потік", type: "range", ...lin(1, 4), round: Math.round, format: v => INT.format(v),
    hint: "background_merges_mutations_concurrency_ratio: місць у пулі = потоки × це число." },
  { key: "scheduling_policy", label: "Планувальник", type: "seg", options: [["round_robin", "round_robin"], ["shortest_task_first", "STF"]],
    hint: "round_robin ділить потоки порівну, shortest_task_first віддає їх найменшим злиттям." },

  { group: "Селектор злиттів" },
  { key: "selector", label: "Алгоритм", type: "seg", options: [["simple", "SimpleMergeSelector"], ["tiered", "tiered"]] },
  { key: "base", label: "merge_selector_base", type: "range", ...lin(1.5, 20), round: v => Math.round(v * 2) / 2, format: v => NUM.format(v),
    hint: "Скільки однакових кусків зливати щонайменше. Більше: менше підсилення записів, більше кусків." },
  { key: "max_parts_to_merge_at_once", label: "Найбільше кусків за раз", type: "range", ...log(2, 300), round: Math.round, format: v => INT.format(v) },
  { key: "max_bytes_at_max_space", label: "Межа розміру злиття", type: "range", ...log(16 * MIB, 150 * GIB), round: v => Math.round(v / MIB) * MIB, format: v => bytes(v),
    hint: "max_bytes_to_merge_at_max_space_in_pool; коли пул майже повний, межа падає до 1 МБ.", disabledWhen: c => c.max_bytes_at_max_space === 0 },
  { key: "merges_off", label: "Вимкнути злиття", type: "toggle", get: c => c.max_bytes_at_max_space === 0,
    set: on => ({ max_bytes_at_max_space: on ? 0 : 150 * GIB }) },

  { group: "Гальмування вставок" },
  { key: "parts_to_delay_insert", label: "parts_to_delay_insert", type: "range", ...log(10, 10000), round: Math.round, format: v => INT.format(v) },
  { key: "parts_to_throw_insert", label: "parts_to_throw_insert", type: "range", ...log(20, 20000), round: Math.round, format: v => INT.format(v) },
  { key: "max_delay_to_insert", label: "max_delay_to_insert", type: "range", ...lin(1, 10), round: Math.round, format: v => `${INT.format(v)} с` },
  { key: "guard", label: "Обмеження за середнім розміром (1 ГіБ)", type: "toggle", get: c => c.max_avg_part_size_for_too_many_parts > 0,
    set: on => ({ max_avg_part_size_for_too_many_parts: on ? GIB : 0 }),
    hint: "Якщо середній кусок більший за 1 ГіБ, гальмування і відхилення вимикаються." },

  { group: "Партиції" },
  { key: "partition_seconds", label: "Нова партиція кожні", type: "select", options: [[0, "ніколи"], [30, "30 с"], [60, "1 хв"], [120, "2 хв"], [300, "5 хв"], [600, "10 хв"]] },
  { key: "retention_partitions", label: "Зберігати партицій", type: "range", ...lin(0, 10), round: Math.round, format: v => (v ? INT.format(v) : "усі"),
    visible: c => c.partition_seconds > 0 },
  { key: "late_insert_fraction", label: "Запізнілі вставки", type: "range", ...lin(0, 0.5), round: v => Math.round(v * 100) / 100, format: v => `${INT.format(v * 100)}%`,
    visible: c => c.partition_seconds > 0 },
  { actions: [["rotate", "Нова партиція зараз"], ["drop", "Видалити найстарішу"]], visible: c => c.partition_seconds > 0 },

  { group: "Диск" },
  { key: "disk_on", label: "Обмежити місце на диску", type: "toggle", get: c => c.disk_bytes > 0, set: on => ({ disk_bytes: on ? 2e12 : 0 }),
    hint: "Злиття стартує, лише коли вільно вдвічі більше за його джерела; вставка без місця для куска отримує NOT_ENOUGH_SPACE." },
  { key: "disk_bytes", label: "Місце для таблиці", type: "range", ...log(10e9, 100e12), round: v => Math.round(v / 1e9) * 1e9, format: v => bytes(v),
    visible: c => c.disk_bytes > 0 },
  { key: "old_parts_lifetime", label: "old_parts_lifetime", type: "range", ...lin(0, 900), round: v => Math.round(v / 10) * 10, format: v => `${INT.format(v)} с`,
    hint: "Скільки куски-джерела злиття ще лежать на диску, поки їх не видалить очищення." },

  { group: "Вартість злиття" },
  { key: "merge_bytes_per_second", label: "Швидкість злиття", type: "range", ...log(20 * MB, 2000 * MB), round: v => Math.round(v / 1e5) * 1e5, format: v => `${NUM.format(v / MB)} МБ/с на потік` },
  { key: "merge_fixed_seconds", label: "Фіксована вартість", type: "range", ...lin(0, 0.2), round: v => Math.round(v * 10000) / 10000, format: v => `${NUM.format(v * 1000)} мс` },
  { key: "merge_noise_cv", label: "Шум тривалості (cv)", type: "range", ...lin(0, 1), round: v => Math.round(v * 100) / 100, format: v => NUM2.format(v) },
  { key: "aux_index", label: "Індекс bloom_filter", type: "toggle", get: c => c.aux.some(a => a === AUX.index), set: (on, c) => ({ aux: toggle(c.aux, AUX.index, on) }) },
  { key: "aux_projection", label: "Проєкція", type: "toggle", get: c => c.aux.some(a => a === AUX.projection), set: (on, c) => ({ aux: toggle(c.aux, AUX.projection, on) }) },
];

// differences between two configurations, as "label: a → b" lines for the comparison bar
export function describeDifferences(a, b) {
  const label = key => ({ aux: "Індекс і проєкція", max_avg_part_size_for_too_many_parts: "Обмеження за середнім розміром", disk_bytes: "Місце для таблиці" })[key]
    || (FIELDS.find(f => f.key === key) || {}).label || key;
  const value = (key, v) => {
    if (key === "aux") return v.length ? v.map(x => (x === AUX.index ? "індекс" : x === AUX.projection ? "проєкція" : JSON.stringify(x))).join(" і ") : "немає";
    if (key === "max_avg_part_size_for_too_many_parts") return v > 0 ? "увімкнене" : "вимкнене";
    if (key === "disk_bytes" && !v) return "без обмеження";
    if (key === "max_bytes_at_max_space" && !v) return "злиття вимкнені";
    const f = FIELDS.find(x => x.key === key);
    if (f && f.format) return f.format(v);
    if (f && f.options) return (f.options.find(([o]) => String(o) === String(v)) || [v, String(v)])[1];
    return String(v);
  };
  const out = [];
  for (const key of Object.keys(b)) {
    if (key === "burst" || key === "seed" || JSON.stringify(a[key]) === JSON.stringify(b[key])) continue;
    out.push(`${label(key)}: ${value(key, a[key])} → ${value(key, b[key])}`);
  }
  return out;
}

function toggle(list, item, on) {
  const rest = list.filter(a => a !== item);
  return on ? [...rest, item] : rest;
}

export class Controls {
  // lab: { config(), configure(changes), action(name), load(presetKey) }
  constructor(root, lab) {
    this.root = root;
    this.lab = lab;
    this.inputs = [];
    const presetSelect = el("select", { id: "preset", "aria-label": "Сценарій" }, ...Object.entries(PRESETS).map(([k, p]) => el("option", { value: k }, p.title)));
    presetSelect.addEventListener("change", () => lab.load(presetSelect.value));
    this.presetSelect = presetSelect;
    this.presetText = el("p", { class: "preset-text" });
    root.append(el("div", { class: "field" }, el("label", { class: "field-label", for: "preset" }, "Сценарій"), presetSelect), this.presetText);
    let group = null;
    for (const f of FIELDS) {
      if (f.group) {
        group = el("details", { class: "group", open: true }, el("summary", {}, f.group));
        root.append(group);
        continue;
      }
      if (f.actions) {
        const row = el("div", { class: "actions" });
        for (const [name, label] of f.actions) {
          const b = el("button", { class: "btn small", type: "button", "data-action": name }, label);
          b.addEventListener("click", () => lab.action(name));
          row.append(b);
        }
        if (f.actions.some(([n]) => n === "burst")) {
          this.burstFactor = el("select", { "aria-label": "Множник сплеску" }, ...[2, 3, 5].map(v => el("option", { value: v, selected: v === 3 }, `×${v}`)));
          this.burstLength = el("select", { "aria-label": "Тривалість сплеску" }, ...[[30, "30 с"], [60, "1 хв"], [180, "3 хв"]].map(([v, t]) => el("option", { value: v, selected: v === 60 }, t)));
          row.insertBefore(el("span", { class: "burst" }, this.burstFactor, this.burstLength), row.children[1]);
        }
        const node = f.hint ? el("div", {}, row, el("p", { class: "hint" }, f.hint)) : row;
        group.append(node);
        this.inputs.push({ f, node });
        continue;
      }
      const id = "f-" + f.key;
      const value = el("span", { class: "field-value" });
      let input;
      if (f.type === "range") {
        input = el("input", { type: "range", id, min: 0, max: 1000, step: 1 });
        input.addEventListener("input", () => {
          const v = f.round(f.fromSlider(+input.value));
          value.textContent = f.format(v);
          this.apply(f, v);
        });
      } else if (f.type === "seg") {
        input = el("div", { class: "seg", role: "group", id }, ...f.options.map(([v, t]) => el("button", { type: "button", "data-value": v }, t)));
        for (const b of input.children) b.addEventListener("click", () => this.apply(f, b.dataset.value));
      } else if (f.type === "select") {
        input = el("select", { id }, ...f.options.map(([v, t]) => el("option", { value: v }, t)));
        input.addEventListener("change", () => this.apply(f, +input.value));
      } else if (f.type === "toggle") {
        input = el("input", { type: "checkbox", id });
        input.addEventListener("change", () => this.lab.configure(f.set(input.checked, this.lab.config())));
      }
      const head = el("div", { class: "field-head" }, el("label", { class: "field-label", for: id }, f.label), value);
      const node = f.type === "toggle" ? el("label", { class: "field toggle" }, input, el("span", {}, f.label)) : el("div", { class: "field" }, head, input);
      if (f.hint) node.append(el("p", { class: "hint" }, f.hint));
      group.append(node);
      this.inputs.push({ f, node, input, value });
    }
  }

  apply(f, v) {
    const changes = { [f.key]: v };
    const c = this.lab.config();
    // parts_to_throw_insert stays above parts_to_delay_insert, as the server requires
    if (f.key === "parts_to_delay_insert" && v >= c.parts_to_throw_insert) changes.parts_to_throw_insert = v + 1;
    if (f.key === "parts_to_throw_insert" && v <= c.parts_to_delay_insert) changes.parts_to_delay_insert = Math.max(1, v - 1);
    this.lab.configure(changes);
  }

  // shows the current configuration
  sync(presetKey) {
    const c = this.lab.config();
    if (presetKey) {
      this.presetSelect.value = presetKey;
      this.presetText.textContent = PRESETS[presetKey].text;
    }
    for (const { f, node, input, value } of this.inputs) {
      node.hidden = f.visible ? !f.visible(c) : false;
      if (!input) continue;
      if (f.type === "range") {
        if (document.activeElement !== input) input.value = f.toSlider(c[f.key]);
        value.textContent = f.format(c[f.key]);
        input.disabled = f.disabledWhen ? f.disabledWhen(c) : false;
      } else if (f.type === "seg") {
        for (const b of input.children) b.setAttribute("aria-pressed", String(b.dataset.value === String(c[f.key])));
      } else if (f.type === "select") {
        input.value = String(c[f.key]);
      } else if (f.type === "toggle") {
        input.checked = f.get(c);
      }
    }
  }

  burstSettings() {
    return [+this.burstFactor.value, +this.burstLength.value];
  }

  setPaused(paused) {
    const b = this.root.querySelector('[data-action="pause"]');
    if (b) b.textContent = paused ? "Відновити вставки" : "Зупинити вставки";
  }
}
