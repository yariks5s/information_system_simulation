import { RESULTS } from "../data/results.js";
import { el, sv, tooltip, bytes, clock, NUM, NUM2, NUM3, INT, PCT } from "./dom.js";
import { Chart, Bars, table, card, ci, niceTicks, S } from "./charts.js";


// null: the event did not happen in every replication
const minutes = v => (v ? `${NUM.format(v[0] / 60)} ± ${NUM.format(v[1] / 60)} хв` : "ніколи");

export function results() {
  const R = RESULTS, root = document.getElementById("tab-results");
  const grid = el("div", { class: "grid two" });
  root.append(grid);

  if (R.e1) {
    const metrics = {
      parts: { name: "активні куски", keys: [["parts_mean", "середнє"], ["parts_quantiles_0.99", "99-й перцентиль"]], fmt: v => INT.format(v) },
      busy: { name: "зайняті потоки", keys: [["busy_threads_mean", "середнє"]], fmt: v => NUM.format(v), max: 16 },
      all: { name: "P(усі 16 зайняті)", keys: [["all_threads_busy", "імовірність"]], fmt: v => NUM2.format(v), max: 1 },
      wa: { name: "підсилення записів", keys: [["write_amplification", "середнє"]], fmt: v => NUM2.format(v) },
      wait: { name: "очікування свіжого куска, с", keys: [["fresh_waiting_mean", "середнє"], ["fresh_waiting_quantiles_0.99", "99-й перцентиль"]], fmt: v => NUM3.format(v) },
      merge: { name: "тривалість злиття, с", keys: [["merge_duration_mean", "середнє"], ["merge_duration_quantiles_0.99", "99-й перцентиль"]], fmt: v => NUM3.format(v) },
    };
    const { card: c, body } = card("E1. Ймовірнісно-часові характеристики від навантаження",
      "Вставки по 3.6 МБ, пул 16 потоків. Затінення: 95% довірчий інтервал.", { tableView: () => table(
        ["вставок/с", "куски", "99-й перц.", "потоки", "P(усі зайняті)", "підсилення", "очікування, с", "злиття, с"],
        R.e1.rates.map((rate, i) => [rate, ...["parts_mean", "parts_quantiles_0.99", "busy_threads_mean", "all_threads_busy", "write_amplification", "fresh_waiting_mean", "merge_duration_mean"]
          .map(k => ci(R.e1.metrics[k][i]))])) });
    const seg = el("div", { class: "seg", role: "group", "aria-label": "Характеристика" });
    const holder = el("div");
    let chart = null;
    const show = key => {
      for (const b of seg.children) b.setAttribute("aria-pressed", String(b.dataset.key === key));
      const m = metrics[key];
      const series = m.keys.map(([k, name], i) => ({ name, color: S(i + 1), markers: true,
        points: R.e1.rates.map((rate, j) => [rate, R.e1.metrics[k][j][0]]),
        band: R.e1.rates.map((rate, j) => [rate, R.e1.metrics[k][j][0] - R.e1.metrics[k][j][1], R.e1.metrics[k][j][0] + R.e1.metrics[k][j][1]]) }));
      const view = { y: { min: 0, max: m.max }, valueFormat: v => m.fmt(v) };
      if (chart) chart.setSeries(series, view);
      else chart = new Chart(holder, { height: 260, x: { label: "вставок за секунду" }, tooltipTitle: x => `${x} вставок/с`, series, ...view });
    };
    for (const [key, m] of Object.entries(metrics)) seg.append(el("button", { type: "button", "data-key": key, onclick: () => show(key) }, m.name));
    body.append(seg, el("div", { style: "height:10px" }), holder);
    c.style.gridColumn = "1 / -1";
    grid.append(c);
    show("parts");
  }

  if (R.e2) {
    const names = { parts_mean: "активні куски", write_amplification: "підсилення записів", busy_threads_mean: "зайняті потоки" };
    const { card: c, body } = card("E2. Розмір вставки за однакового потоку даних",
      "180 МБ/с вставлених даних дрібними або великими вставками, пул 4 і 16 потоків.", { tableView: () => table(
        ["пул", "вставка, МБ", ...Object.values(names)],
        R.e2.pools.flatMap((pool, i) => R.e2.sizes.map((size, j) => [String(pool), NUM3.format(size), ...Object.keys(names).map(k => ci(R.e2.metrics[k][i][j]))]))) });
    new Chart(body, { height: 260, x: { label: "розмір вставки, МБ", log: true, format: v => NUM3.format(v) }, y: { min: 0 },
      valueFormat: v => INT.format(v), tooltipTitle: x => `вставки по ${NUM3.format(x)} МБ`,
      series: R.e2.pools.map((pool, i) => ({ name: `пул ${pool}: активні куски`, short: `пул ${pool}`, color: S(i + 1), markers: true,
                                              points: R.e2.sizes.map((size, j) => [size, R.e2.metrics.parts_mean[i][j][0]]) })) });
    grid.append(c);
  }

  if (R.e3) {
    const names = { "pool 16": "пул 16", "pool 4": "пул 4", "pool 16 + projection": "пул 16 + проєкція" };
    const { card: c, body } = card("E3. Межа стійкості",
      `Найбільший потік даних, за якого за ${R.e3.until / 60} хв жодна партиція не дійшла до parts_to_delay_insert в жодній з 6 реплік (обмеження за середнім розміром куска вимкнене). У таблиці: інтервал бісекції.`, { tableView: () => table(
        ["варіант", "вставка, МБ", "вставок/с", "МБ/с"], R.e3.variants.flatMap(v => v.points.map(p => [names[v.name] || v.name, NUM.format(p[0]), `${INT.format(p[1])}–${INT.format(p[2])}`, INT.format(p[3])]))) });
    new Chart(body, { height: 260, x: { label: "розмір вставки, МБ", log: true, format: v => NUM3.format(v) }, y: { min: 0, label: "МБ/с" },
      valueFormat: v => INT.format(v) + " МБ/с", tooltipTitle: x => `вставки по ${NUM3.format(x)} МБ`,
      series: R.e3.variants.map((v, i) => ({ name: names[v.name] || v.name, color: S(i + 1), markers: true, points: v.points.map(p => [p[0], p[3]]) })) });
    grid.append(c);
  }

  if (R.e4) {
    const { card: c, body } = card("E4. Компроміс селектора",
      `${R.e4.rate} вставок/с. Підпис точки: значення merge_selector_base. Менше підсилення записів коштує більшої кількості кусків, а tiered при base 2 і 3 деградує.`, { tableView: () => table(
        ["селектор", "base", "підсилення", "куски", "потоки"], R.e4.selectors.flatMap(s => s.bases.map((b, i) => [s.name, b, ci(s.wa[i]), ci(s.parts[i]), ci(s.busy[i])]))) });
    new Chart(body, { height: 260, mode: "scatter", x: { label: "підсилення записів" }, y: { log: true, label: "куски" },
      scatterRows: (s, i) => { const sel = R.e4.selectors.find(x => x.name === s.name); return [
        { name: "підсилення записів", value: ci(sel.wa[i]) }, { name: "активні куски", value: ci(sel.parts[i]) }, { name: "зайняті потоки", value: ci(sel.busy[i]) }]; },
      series: R.e4.selectors.map((s, i) => ({ name: s.name, color: S(i + 1), connect: true, labels: s.bases.map(b => String(b)), labelOffset: i ? [6, 14] : [-4, -9],
        points: s.wa.map((w, j) => [w[0], s.parts[j][0]]) })) });
    grid.append(c);
  }

  if (R.e6) {
    const { card: c, body } = card("E6. Гальмування як зворотний зв'язок",
      `Пропонований потік ${R.e6.offered} вставок/с, вище за межу стійкості. Без обмеження за середнім розміром куска замкнені клієнти самостабілізуються біля parts_to_delay_insert; з дефолтним обмеженням захист вимикається, коли середній кусок перевищує 1 ГіБ.`,
      { wide: true, tableView: () => table(["варіант", "потік, вставок/с", "куски", "затримано", "відхилено"],
        R.e6.variants.map(v => [v.name.replace("open", "відкритий").replace("closed", "замкнений").replace("no guard", "без обмеження").replace("guard", "обмеження"), ci(v.rate), ci(v.parts_mean), PCT.format(v.delayed[0]), PCT.format(v.rejected[0])])) });
    const row = el("div", { class: "grid two" });
    body.append(row);
    for (const [guard, title] of [["guard", "з обмеженням (дефолт)"], ["no guard", "max_avg_part_size_for_too_many_parts = 0"]]) {
      const holder = el("div");
      row.append(el("div", {}, el("h3", {}, title), holder));
      new Chart(holder, { height: 230, x: { label: "модельний час, хв", format: v => INT.format(v) }, y: { min: 0 }, valueFormat: v => INT.format(v),
        thresholds: [{ y: 1000, label: "parts_to_delay_insert" }, { y: 3000, label: "parts_to_throw_insert" }], tooltipTitle: x => clock(x * 60),
        series: ["open", "closed"].map((inp, i) => { const v = R.e6.variants.find(x => x.name === `${inp}, ${guard}`);
          const short = inp === "open" ? "відкритий" : "замкнений";
          return { name: `${short} вхід, ${INT.format(v.rate[0])}/с, відхилено ${PCT.format(v.rejected[0])}`, short, color: S(i + 1), points: R.e6.grid.map((t, j) => [t / 60, v.parts[j]]) }; }) });
    }
    grid.append(c);
  }

  if (R.e7) {
    const { card: c, body } = card("E7. Відновлення після сплеску",
      "150 вставок/с і 5-хвилинний сплеск. Відновлення: перший момент, коли кусків не більше ніж на 10% більше, ніж у прогоні з тими самими випадковими числами без сплеску.",
      { tableView: () => table(["множник", "пік кусків", "відновлення"], R.e7.runs.filter(r => r.factor !== 1).map(r => [`×${r.factor}`, INT.format(r.peak), r.recovery ? `${NUM.format(r.recovery[0] / 60)} ± ${NUM.format(r.recovery[1] / 60)} хв` : "не відновилось"])) });
    const [start, length] = R.e7.burst;
    const shown = R.e7.runs;
    new Chart(body, { height: 260, x: { label: "модельний час, хв", format: v => INT.format(v) },
      y: { min: 0 }, valueFormat: v => INT.format(v), tooltipTitle: x => clock(x * 60),
      series: shown.map((r, i) => ({ name: r.factor === 1 ? "без сплеску" : `сплеск ×${r.factor}`, color: r.factor === 1 ? "var(--axis)" : S(i),
        points: R.e7.grid.map((t, j) => [t / 60, r.series[j]]).filter(p => p[0] >= start / 60 - 10 && p[0] <= start / 60 + 45) })) });
    body.append(el("p", { class: "note" }, "Час відновлення: " + shown.filter(r => r.factor !== 1).map(r => `×${r.factor}: ${r.recovery ? NUM.format(r.recovery[0] / 60) + " хв" : "не відновилось"}`).join(", ") + `. Сплеск триває ${length / 60} хв.`));
    grid.append(c);
  }

  if (R.e10) {
    const names = { "one partition": "одна партиція", "rotation": "ротація", "rotation, 10% late inserts": "ротація, 10% запізнілих вставок" };
    const { card: c, body } = card("E10. Ротація партицій",
      `Нова партиція кожні ${R.e10.rotation.partition_seconds / 60} модельних хвилин, зберігаються ${R.e10.rotation.retention_partitions} найновіші. Ротація робить кількість кусків стаціонарною.`,
      { wide: true, tableView: () => table(["вхід", "варіант", "куски", "підсилення", "потік", "затримано", "відхилено"],
        ["open", "closed"].flatMap(part => R.e10[part].variants.map(v => [part === "open" ? "150/с відкритий" : "35 замкнених клієнтів", names[v.name] || v.name,
          ci(v.stats.parts_mean), ci(v.stats.write_amplification), ci(v.stats.insert_rate), PCT.format(v.stats.delayed_fraction[0]), PCT.format(v.stats.rejected_fraction[0])]))) });
    const row = el("div", { class: "grid two" });
    body.append(row);
    for (const [part, title] of [["open", "150 вставок/с, відкритий вхід"], ["closed", "35 замкнених клієнтів, пропонують 350/с"]]) {
      const holder = el("div");
      row.append(el("div", {}, el("h3", {}, title), holder));
      const d = R.e10[part];
      new Chart(holder, { height: 230, x: { label: "модельний час, хв", format: v => INT.format(v) }, y: { min: 0 }, valueFormat: v => INT.format(v), tooltipTitle: x => clock(x * 60),
        thresholds: part === "closed" ? [{ y: 1000, label: "parts_to_delay_insert" }] : [],
        series: d.variants.map((v, i) => ({ name: names[v.name] || v.name, short: v.name === "one partition" ? "одна" : v.name === "rotation" ? "ротація" : "запізнілі",
          color: S(i + 1), points: d.grid.map((t, j) => [t / 60, v.parts[j]]) })) });
    }
    grid.append(c);
  }

  if (R.e11) {
    const names = { "no limit": "без обмеження", "2 TB, old_parts_lifetime 480 s": "2 ТБ, old_parts_lifetime 480 с", "2 TB, old_parts_lifetime 60 s": "2 ТБ, old_parts_lifetime 60 с" };
    const short = { "no limit": "без обмеження", "2 TB, old_parts_lifetime 480 s": "480 с", "2 TB, old_parts_lifetime 60 s": "60 с" };
    const { card: c, body } = card("E11. Диск, що заповнюється",
      `Одна партиція, 100 вставок/с, місця для таблиці ${bytes(R.e11.disk_bytes)}. Злиття стартує, лише коли вільно вдвічі більше за його джерела, а злиті джерела ще old_parts_lifetime лежать на диску. Тому злиття дробляться задовго до першої відхиленої вставки.`,
      { wide: true, tableView: () => table(["варіант", "межа злиття падає", "перша NOT_ENOUGH_SPACE", "NOT_ENOUGH_SPACE в останні 10 хв", "куски", "підсилення"],
        R.e11.variants.map(v => [names[v.name] || v.name, minutes(v.cap_drop), minutes(v.first_nospace),
          v.nospace_last_10_min ? PCT.format(v.nospace_last_10_min[0]) : "0%", ci(v.stats.parts_mean), ci(v.stats.write_amplification)])) });
    const row = el("div", { class: "grid two" });
    body.append(row);
    const d = R.e11;
    for (const [key, title, format] of [["used", "Зайнято на диску", v => bytes(v)], ["parts", "Активні куски", v => INT.format(v)]]) {
      const holder = el("div");
      row.append(el("div", {}, el("h3", {}, title), holder));
      new Chart(holder, { height: 230, x: { label: "модельний час, хв", format: v => INT.format(v) }, y: { min: 0, format }, valueFormat: format, tooltipTitle: x => clock(x * 60),
        thresholds: key === "used" ? [{ y: d.disk_bytes, label: "disk_bytes" }] : [],
        series: d.variants.map((v, i) => ({ name: names[v.name] || v.name, short: short[v.name] || v.name, color: S(i + 1), points: d.grid.map((t, j) => [t / 60, v[key][j]]) })) });
    }
    grid.append(c);
  }

  if (R.e5) {
    const names = { parts_mean: "активні куски", fresh_waiting_mean: "очікування свіжого куска, с", merge_duration_mean: "тривалість злиття, с",
                    merge_duration_p99: "99-й перцентиль злиття, с", write_amplification: "підсилення записів" };
    const { card: c, body } = card("E5. shortest_task_first проти round_robin", "Парні різниці (STF мінус RR) на спільних випадкових числах, 95% довірчі інтервали.");
    body.append(table(["характеристика", ...R.e5.rates.map(r => `${r} вставок/с`)],
      Object.keys(names).map(k => [names[k], ...R.e5.rates.map(r => ci(R.e5.differences[r][k]))])));
    grid.append(c);
  }

  if (R.e8) {
    const names = { "none": "без структур", "bloom_filter index": "індекс bloom_filter", "projection": "проєкція", "projection + index": "проєкція + індекс" };
    const { card: c, body } = card("E8. Вартість допоміжних структур", "100 вставок/с по 3.6 МБ.");
    body.append(table(["варіант", "куски", "зайняті потоки", "злиття, с", "підсилення"],
      R.e8.variants.map((v, i) => [names[v] || v, ci(R.e8.runs[i].parts_mean), ci(R.e8.runs[i].busy_threads_mean), ci(R.e8.runs[i].merge_duration_mean), ci(R.e8.runs[i].write_amplification)])));
    grid.append(c);
  }

  if (R.e9) {
    const factors = { "insert size": "вставка 0.9 → 3.6 МБ", "threads": "пул 8 → 16", "base": "base 3 → 8", "scheduling_policy": "round_robin → STF", "projection": "без → з проєкцією" };
    const responses = { parts_mean: "активні куски", write_amplification: "підсилення записів", fresh_lifetime_mean: "час життя свіжого куска, с", busy_threads_mean: "зайняті потоки" };
    const { card: c, body } = card("E9. Головні ефекти факторного плану 2⁵",
      "180 МБ/с вставлених даних, 6 реплік на кожну з 32 конфігурацій. Ефект: зміна середнього при переході фактора з нижнього рівня на верхній, з 95% інтервалом за парними ефектами реплік.", { wide: true, tableView: () => table(
        ["фактор", ...R.e9.responses.map(r => responses[r] || r)], R.e9.factors.map(f => [factors[f] || f, ...R.e9.responses.map(r => ci(R.e9.effects[r].main[f]))])) });
    const row = el("div", { class: "grid two" });
    body.append(row);
    for (const r of R.e9.responses) {
      const holder = el("div");
      row.append(el("div", {}, el("h3", {}, responses[r] || r), holder));
      new Bars(holder, { name: responses[r] || r, color: S(1), labels: R.e9.factors.map(f => factors[f] || f), values: R.e9.factors.map(f => R.e9.effects[r].main[f][0]) });
    }
    grid.append(c);
  }
}

export function validation() {
  const root = document.getElementById("tab-validation");
  const cases = RESULTS.validation;
  if (!cases.length) { root.append(el("p", { class: "loading" }, "Немає даних валідації.")); return; }
  const names = { parts_mean: "активні куски", busy_threads_mean: "зайняті потоки", fresh_waiting_mean: "очікування свіжого куска",
                  fresh_lifetime_mean: "час життя свіжого куска", merge_duration_mean: "тривалість злиття", write_amplification: "підсилення записів",
                  delayed_fraction: "частка затриманих вставок", delay_mean_ms: "середня затримка вставки" };
  root.append(el("div", { class: "card prose", style: "margin-bottom:16px" },
    el("h2", {}, "Модель проти живого сервера"),
    el("p", {}, "Кожне навантаження проганялося 3 рази по 6 хвилин на окремому сервері ClickHouse 26.10 і 20 разів у моделі. Розміри вставок модель брала з подій NewPart самого прогону, а вартість злиття лише з калібрування на інших навантаженнях."),
    el("p", {}, "Середні характеристики збігаються в межах 3.3%. Підсилення записів у моделі на 6–8% вище. Гальмування залежить від хвоста розподілу кількості кусків, а на сервері цей хвіст важчий, тому частку затриманих вставок модель недооцінює на 13%.")));
  const grid = el("div", { class: "grid three" });
  root.append(grid);
  let lim = 10;
  for (const cs of cases) for (const r of cs.rows) if (names[r.metric] && r.live) {
    const v = (r.model / r.live - 1) * 100, h = 100 * r.model / r.live * Math.hypot(r.model ? r.model_half / r.model : 0, r.live_half / r.live);
    lim = Math.max(lim, Math.abs(v) + h);
  }
  lim = Math.ceil(lim * 1.1 / 10) * 10;
  for (const cs of cases) {
    const rows = cs.rows.filter(r => names[r.metric] && r.live);
    const { card: c, body } = card(cs.title, "Відхилення моделі від сервера, %. Риска: 95% довірчий інтервал. Шкала однакова для трьох навантажень.", { tableView: () => table(
      ["характеристика", "сервер", "модель", "різниця"], rows.map(r => [names[r.metric], `${NUM3.format(r.live)} ± ${NUM3.format(r.live_half)}`, `${NUM3.format(r.model)} ± ${NUM3.format(r.model_half)}`, `${r.model >= r.live ? "+" : ""}${NUM.format((r.model / r.live - 1) * 100)}%`])) });
    const values = rows.map(r => (r.model / r.live - 1) * 100);
    const halves = rows.map(r => 100 * r.model / r.live * Math.hypot(r.model ? r.model_half / r.model : 0, r.live_half / r.live));
    const svg = sv("svg", { class: "chart" });
    body.append(svg);
    const draw = () => {
      const width = Math.max(260, body.clientWidth), band = 30, m = { l: 178, r: 14, t: 8, b: 26 };
      const height = m.t + m.b + band * rows.length;
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      svg.setAttribute("height", height);
      svg.replaceChildren();
      const X = v => m.l + (v + lim) / (2 * lim) * (width - m.l - m.r);
      for (const v of niceTicks(-lim, lim, 4)) {
        const x = Math.round(X(v)) + 0.5;
        svg.append(sv("line", { class: "grid-line", x1: x, x2: x, y1: m.t, y2: height - m.b }));
        svg.append(sv("text", { class: "tick", x, y: height - 6, "text-anchor": "middle" }, (v > 0 ? "+" : "") + NUM3.format(v)));
      }
      svg.append(sv("line", { class: "base-line", x1: Math.round(X(0)) + 0.5, x2: Math.round(X(0)) + 0.5, y1: m.t, y2: height - m.b }));
      rows.forEach((r, i) => {
        const y = m.t + i * band + band / 2;
        svg.append(sv("text", { class: "tick", x: m.l - 8, y: y + 4, "text-anchor": "end", style: "fill:var(--text-secondary);font-size:12px" }, names[r.metric]));
        svg.append(sv("line", { x1: X(values[i] - halves[i]), x2: X(values[i] + halves[i]), y1: y, y2: y, style: `stroke:${S(1)};stroke-width:2;stroke-linecap:round` }));
        svg.append(sv("circle", { cx: X(values[i]), cy: y, r: 4.5, style: `fill:${S(1)};stroke:var(--surface-1);stroke-width:2` }));
        svg.append(sv("text", { class: "point-label", x: X(values[i]), y: y - 8, "text-anchor": "middle" }, (values[i] > 0 ? "+" : "") + NUM.format(values[i]) + "%"));
        const hit = sv("rect", { class: "hit", x: 0, y: y - band / 2, width, height: band });
        hit.addEventListener("pointermove", e => tooltip.show(e.clientX, e.clientY, names[r.metric], [
          { name: "сервер", value: `${NUM3.format(r.live)} ± ${NUM3.format(r.live_half)}` },
          { name: "модель", value: `${NUM3.format(r.model)} ± ${NUM3.format(r.model_half)}` },
          { name: "різниця", value: (values[i] > 0 ? "+" : "") + NUM.format(values[i]) + "%" }]));
        hit.addEventListener("pointerleave", () => tooltip.hide());
        svg.append(hit);
      });
    };
    grid.append(c);
    new ResizeObserver(draw).observe(body);
  }
}

export function model() {
  const c = RESULTS.calibration && RESULTS.calibration.model;
  if (c) {
    const kv = document.getElementById("calibration");
    const add = (k, v) => kv.append(el("dt", {}, k), el("dd", {}, v));
    add("фіксована вартість злиття c₀", NUM2.format(c.merge_fixed_seconds * 1000) + " мс");
    add("швидкість злиття 1/c₁", NUM.format(c.merge_bytes_per_second / 1e6) + " МБ/с на потік");
    add("коефіцієнт варіації шуму ε", NUM2.format(c.merge_noise_cv));
    add("середня вставка", NUM2.format(c.insert_bytes_mean / 1e6) + " МБ, cv " + NUM2.format(c.insert_bytes_cv));
    add("індекс bloom_filter (s, δ)", `${NUM3.format(c.index_aux[0])}, ${NUM3.format(c.index_aux[1])}`);
    add("проєкція (s, δ)", `${NUM3.format(c.projection_aux[0])}, ${NUM3.format(c.projection_aux[1])}`);
  }
}

