"""report figures from results/*.json: python3 plots.py [--quick]"""
import json
import os
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

SRC = "results_quick" if "--quick" in sys.argv else "results"
# slots 3 and 4 are below 3:1 contrast on the surface, so series are also labeled directly
SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"]
INK, INK2, MUTED, GRID, AXIS, SURFACE = "#0b0b0b", "#52514e", "#898781", "#e1e0d9", "#c3c2b7", "#fcfcfb"

plt.rcParams.update({
    "figure.facecolor": SURFACE, "axes.facecolor": SURFACE, "savefig.facecolor": SURFACE,
    "axes.edgecolor": AXIS, "axes.linewidth": 0.8, "axes.labelcolor": INK2, "axes.titlecolor": INK,
    "axes.titlesize": 10, "axes.labelsize": 9, "axes.titlelocation": "left", "axes.titleweight": "bold",
    "axes.spines.top": False, "axes.spines.right": False, "axes.grid": True, "axes.axisbelow": True,
    "grid.color": GRID, "grid.linewidth": 0.6, "grid.linestyle": "-",
    "xtick.color": MUTED, "ytick.color": MUTED, "xtick.labelsize": 8, "ytick.labelsize": 8,
    "xtick.labelcolor": INK2, "ytick.labelcolor": INK2,
    "legend.frameon": False, "legend.fontsize": 8, "legend.labelcolor": INK2,
    "lines.linewidth": 1.6, "lines.markersize": 4.5, "font.size": 9,
})


def load(name):
    path = f"{SRC}/{name}.json"
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return json.load(f)


def save(fig, name):
    fig.tight_layout()
    fig.savefig(f"{SRC}/{name}.png", dpi=160)
    plt.close(fig)
    print("wrote", f"{SRC}/{name}.png")


METRIC_NAMES = {
    "parts_mean": "активні куски", "busy_threads_mean": "зайняті потоки", "fresh_waiting_mean": "очікування свіжого куска",
    "fresh_lifetime_mean": "час життя свіжого куска", "merge_duration_mean": "тривалість злиття",
    "write_amplification": "підсилення записів", "delayed_fraction": "частка затриманих вставок",
    "delay_mean_ms": "середня затримка вставки",
}


def end_labels(ax, items, gap=0.045):
    if not items:
        return
    ax.autoscale_view()  # callers must set scales and limits first
    to_axes = ax.transAxes.inverted()
    points = sorted(((to_axes.transform(ax.transData.transform((x, y)))[1], x, y, text) for x, y, text in items))
    placed = []
    for fy, x, y, text in points:
        fy = max(fy, placed[-1] + gap) if placed else fy
        placed.append(fy)
        ax.annotate(text, (x, y), xytext=(1.01, fy), textcoords="axes fraction",
                    va="center", fontsize=8, color=INK2, annotation_clip=False)


def ci(run, key):
    mean, half = run["stats"][key]
    return mean, (half if np.isfinite(half) else 0.0)


def line(ax, x, runs, key, color, label=None):
    y = np.array([ci(r, key)[0] for r in runs])
    e = np.array([ci(r, key)[1] for r in runs])
    ax.errorbar(x, y, yerr=e, color=color, marker="o", capsize=2, elinewidth=0.8, label=label)
    return (x[-1], y[-1], label)


def e1(d):
    rates, runs = d["rates"], d["runs"]
    panels = [
        ("Активні куски", [("parts_mean", "середнє"), ("parts_quantiles_0.99", "99-й перцентиль")]),
        ("Зайняті потоки пулу (з 16)", [("busy_threads_mean", None)]),
        ("Підсилення записів", [("write_amplification", None)]),
        ("Очікування свіжого куска, с", [("fresh_waiting_mean", "середнє"), ("fresh_waiting_quantiles_0.99", "99-й перцентиль")]),
        ("Тривалість злиття, с", [("merge_duration_mean", "середнє"), ("merge_duration_quantiles_0.99", "99-й перцентиль")]),
        ("Імовірність зайнятості всіх 16 потоків", [("all_threads_busy", None)]),
    ]
    fig, axes = plt.subplots(2, 3, figsize=(13, 6))
    for ax, (title, keys) in zip(axes.flat, panels):
        ends = [line(ax, rates, runs, key, SERIES[i], label) for i, (key, label) in enumerate(keys)]
        ax.set_title(title)
        ax.set_xlabel("вставок за секунду")
        ax.set_ylim(bottom=0)
        if len(keys) > 1:
            ax.legend(loc="upper left")
            end_labels(ax, ends)
    save(fig, "e1_load")

    grid = np.array(d["grid"]) / 60
    fig, ax = plt.subplots(figsize=(7, 3.8))
    shown = [r for r in (100, 200, 250, 300) if r in rates]
    ends = []
    for i, rate in enumerate(shown):
        y = runs[rates.index(rate)]["series"]["parts"]
        ax.plot(grid, y, color=SERIES[i], label=f"{rate}/с")
        ends.append((grid[-1], y[-1], f"{rate}/с"))
    ax.set_title("Кількість активних кусків у часі (середнє по репліках)")
    ax.set_xlabel("модельний час, хв")
    ax.set_ylabel("куски")
    ax.set_ylim(bottom=0)
    ax.legend(loc="upper left")
    end_labels(ax, ends)
    save(fig, "e1_series")


def e2(d):
    sizes = np.array(d["sizes"]) / 1e6
    n = len(sizes)
    fig, axes = plt.subplots(1, 3, figsize=(12, 3.6))
    for ax, (key, title) in zip(axes, [("parts_mean", "Активні куски"), ("write_amplification", "Підсилення записів"),
                                      ("busy_threads_mean", "Зайняті потоки")]):
        ends = [line(ax, sizes, d["runs"][i * n : (i + 1) * n], key, SERIES[i], f"пул {pool}") for i, pool in enumerate(d["pools"])]
        ax.set_xscale("log")
        ax.set_xlabel("розмір вставки, МБ (потік даних сталий)")
        ax.set_title(title)
        ax.set_ylim(bottom=0)
        ax.legend(loc="best")
        end_labels(ax, ends)
    save(fig, "e2_batch")


def e3(d):
    variants = sorted({label for label, _ in d["labels"]}, key=[l for l, _ in d["labels"]].index)
    names = {"pool 16": "пул 16", "pool 4": "пул 4", "pool 16 + projection": "пул 16 + проєкція"}
    fig, axes = plt.subplots(1, 2, figsize=(11, 3.8))
    ends = [[], []]
    for i, variant in enumerate(variants):
        points = [(size / 1e6, low) for (label, size), (low, _) in zip(d["labels"], d["bounds"]) if label == variant]
        x, y = np.array(points).T
        for k, (ax, values) in enumerate(((axes[0], y), (axes[1], y * x))):
            ax.plot(x, values, color=SERIES[i], marker="o", label=names[variant])
            ends[k].append((x[-1], values[-1], names[variant]))
    axes[0].set_title("Межа стійкості: вставок за секунду")
    axes[0].set_yscale("log")
    axes[1].set_title("Межа стійкості: МБ/с вставлених даних")
    axes[1].set_ylim(bottom=0)
    for ax, e in zip(axes, ends):
        ax.set_xscale("log")
        ax.set_xlabel("розмір вставки, МБ")
        ax.legend(loc="best")
        end_labels(ax, e)
    save(fig, "e3_boundary")


def e4(d):
    fig, ax = plt.subplots(figsize=(6.5, 4.2))
    n = len(d["simple"])
    for i, (label, bases, runs) in enumerate([("SimpleMergeSelector", d["simple"], d["runs"][:n]),
                                               ("tiered", d["tiered"], d["runs"][n:])]):
        x = [ci(r, "write_amplification")[0] for r in runs]
        y = [ci(r, "parts_mean")[0] for r in runs]
        ax.errorbar(x, y, xerr=[ci(r, "write_amplification")[1] for r in runs], yerr=[ci(r, "parts_mean")[1] for r in runs],
                    color=SERIES[i], marker="o", capsize=2, elinewidth=0.8, label=label)
        for b, xi, yi in zip(bases, x, y):
            ax.annotate(f"{b:g}", (xi, yi), xytext=(4, 3) if i == 0 else (4, -10), textcoords="offset points", fontsize=7, color=INK2)
    ax.set_title(f"Компроміс селектора, {d['rate']} вставок/с (підписи: base)")
    ax.set_xlabel("підсилення записів")
    ax.set_ylabel("середня кількість активних кусків")
    ax.set_yscale("log")
    ax.legend(loc="center left")
    save(fig, "e4_selector")


def e5(d):
    metrics = [("parts_mean", "активні куски"), ("fresh_waiting_mean", "очікування свіжого куска, с"),
               ("merge_duration_mean", "тривалість злиття, с"), ("merge_duration_p99", "99-й перцентиль злиття, с"),
               ("write_amplification", "підсилення записів")]
    fig, axes = plt.subplots(1, len(metrics), figsize=(12, 2.8), sharey=True)
    for ax, (key, title) in zip(axes, metrics):
        for i, rate in enumerate(d["rates"]):
            mean, half = d["differences"][str(rate)][key]
            ax.errorbar([mean], [i], xerr=[half if np.isfinite(half) else 0], color=SERIES[0], marker="o", capsize=3)
        ax.axvline(0, color=AXIS, linewidth=0.8)
        ax.set_title(title, fontsize=8)
        ax.xaxis.set_major_locator(matplotlib.ticker.MaxNLocator(3))
        ax.set_yticks(range(len(d["rates"])), [f"{r}/с" for r in d["rates"]])
        ax.set_ylim(-0.5, len(d["rates"]) - 0.5)
    fig.suptitle("shortest_task_first мінус round_robin, 95% довірчі інтервали на спільних випадкових числах", x=0.01, ha="left", fontsize=9, color=INK)
    save(fig, "e5_policy")


def e6(d):
    grid = np.array(d["grid"]) / 60
    runs = dict(zip(d["variants"], d["runs"]))
    fig, axes = plt.subplots(1, 2, figsize=(12, 3.9), sharey=True)
    for ax, guard, title in ((axes[0], "guard", "З обмеженням за середнім розміром куска (за замовчуванням)"),
                             (axes[1], "no guard", "max_avg_part_size_for_too_many_parts = 0")):
        ends = []
        for i, (inp, label) in enumerate((("open", "відкритий вхід"), ("closed", "замкнений вхід"))):
            run = runs[f"{inp}, {guard}"]
            y = run["series"]["parts"]
            rate = run["stats"]["fresh_rate"][0]  # accepted, not offered
            rejected = run["stats"]["rejected_fraction"][0]
            text = f"{label}: прийнято {rate:.0f}/с, відхилено {rejected:.1%}"
            ax.plot(grid, y, color=SERIES[i], label=text)
            ends.append((grid[-1], y[-1], label))
        for level, name in ((1000, "parts_to_delay_insert"), (3000, "parts_to_throw_insert")):
            ax.axhline(level, color=MUTED, linewidth=0.8)
            ax.annotate(name, (grid[0], level), xytext=(2, 3), textcoords="offset points", fontsize=7, color=MUTED)
        ax.set_title(title, fontsize=9)
        ax.set_xlabel("модельний час, хв")
        ax.set_ylim(bottom=0)
        ax.legend(loc="center right")
        end_labels(ax, ends)
    axes[0].set_ylabel("активні куски")
    fig.suptitle(f"Пропонований потік {d['offered']} вставок/с", x=0.01, ha="left", fontsize=10, color=INK, fontweight="bold")
    save(fig, "e6_feedback")


def e7(d):
    grid = np.array(d["grid"]) / 60
    fig, axes = plt.subplots(1, 2, figsize=(12, 3.8), gridspec_kw=dict(width_ratios=[2, 1]))
    reference = [r for r in d["runs"] if r["factor"] == 1.0][0]
    axes[0].plot(grid, reference["series"], color=AXIS, label="без сплеску")
    shown = [r for r in d["runs"] if r["factor"] != 1.0]
    for i, run in enumerate(shown):
        axes[0].plot(grid, run["series"], color=SERIES[i], label=f"сплеск ×{run['factor']:g}")
    start, length = d["burst"]
    axes[0].axvspan(start / 60, (start + length) / 60, color=GRID, alpha=0.5, linewidth=0)
    axes[0].set_title("Активні куски під час і після 5-хвилинного сплеску")
    axes[0].set_xlabel("модельний час, хв")
    axes[0].set_xlim(start / 60 - 10, start / 60 + 45)
    axes[0].legend(loc="upper right")
    recovered = [r for r in shown if r["recovery"]]  # none when some seed never came back below the band
    factors = [r["factor"] for r in recovered]
    means = [r["recovery"][0] / 60 for r in recovered]
    halves = [r["recovery"][1] / 60 if np.isfinite(r["recovery"][1]) else 0 for r in recovered]
    axes[1].errorbar(factors, means, yerr=halves, color=SERIES[0], marker="o", capsize=2)
    axes[1].set_title("Час відновлення, хв")
    axes[1].set_xlabel("множник сплеску")
    axes[1].set_ylim(bottom=0)
    save(fig, "e7_burst")


def e9(d):
    names = {"insert size": "вставка 0.9 → 3.6 МБ", "threads": "пул 8 → 16", "base": "base 3 → 8",
             "scheduling_policy": "round_robin → STF", "projection": "без → з проєкцією"}
    responses = [r for r in d["responses"] if any(abs(v[0]) > 1e-12 for v in d["effects"][r]["main"].values())]
    fig, axes = plt.subplots(1, len(responses), figsize=(3.1 * len(responses) + 1.5, 3.2))
    for ax, response in zip(axes, responses):
        main = d["effects"][response]["main"]
        factors = list(main)
        ax.barh(range(len(factors)), [main[f][0] for f in factors], xerr=[main[f][1] for f in factors], color=SERIES[0], height=0.6,
                error_kw=dict(ecolor=INK2, elinewidth=0.8, capsize=2))
        ax.set_yticks(range(len(factors)), [names[f] for f in factors] if ax is axes[0] else [""] * len(factors))
        ax.axvline(0, color=AXIS, linewidth=0.8)
        ax.set_title(METRIC_NAMES[response] + (", с" if response.endswith(("lifetime_mean", "waiting_mean")) else ""), fontsize=9)
        ax.xaxis.set_major_locator(matplotlib.ticker.MaxNLocator(4))
        ax.invert_yaxis()
    fig.suptitle("Головні ефекти факторного плану 2^5: зміна середнього при переході фактора з рівня −1 на +1, з 95% інтервалом",
                 x=0.01, ha="left", fontsize=9, color=INK)
    save(fig, "e9_factorial")


def e10(d):
    names = {"one partition": "одна партиція", "rotation": "ротація", "rotation, 10% late inserts": "ротація, 10% запізнілих"}
    fig, axes = plt.subplots(1, 2, figsize=(12, 3.9))
    for ax, part, title in ((axes[0], "open", "150 вставок/с, відкритий вхід"), (axes[1], "closed", "35 замкнених клієнтів, пропонують 350/с")):
        grid = np.array(d[part]["grid"]) / 60
        ends = []
        for i, (variant, run) in enumerate(zip(d[part]["variants"], d[part]["runs"])):
            y = run["series"]["parts"]
            ax.plot(grid, y, color=SERIES[i], label=names[variant])
            ends.append((grid[-1], y[-1], names[variant]))
        if part == "closed":
            ax.axhline(1000, color=MUTED, linewidth=0.8)
            ax.annotate("parts_to_delay_insert", (grid[0], 1000), xytext=(2, 3), textcoords="offset points", fontsize=7, color=MUTED)
        ax.set_title(title, fontsize=9)
        ax.set_xlabel("модельний час, хв")
        ax.set_ylim(bottom=0)
        ax.legend(loc="lower right" if part == "open" else "upper left")
        end_labels(ax, ends)
    axes[0].set_ylabel("активні куски")
    rotation = d["rotation"]
    fig.suptitle(f"Ротація партицій: нова кожні {rotation['partition_seconds'] / 60:g} хв, зберігаються {rotation['retention_partitions']}",
                 x=0.01, ha="left", fontsize=10, color=INK, fontweight="bold")
    save(fig, "e10_partitions")


def e11(d):
    names = {"no limit": "без обмеження", "2 TB, old_parts_lifetime 480 s": "2 ТБ, old_parts_lifetime 480 с",
             "2 TB, old_parts_lifetime 60 s": "2 ТБ, old_parts_lifetime 60 с"}
    grid = np.array(d["grid"]) / 60
    fig, axes = plt.subplots(1, 3, figsize=(13, 3.9))
    for i, (variant, run) in enumerate(zip(d["variants"], d["runs"])):
        sr = run["series"]
        label = names.get(variant, variant)
        axes[0].plot(grid, np.array(sr["used"]) / 1e12, color=SERIES[i], label=label)
        if variant != "no limit":
            axes[0].plot(grid, np.array(sr["outdated"]) / 1e12, color=SERIES[i], linestyle=(0, (3, 2)), linewidth=1.2)
        axes[1].plot(grid, sr["parts"], color=SERIES[i], label=label)
        axes[2].plot(grid, np.maximum(np.array(sr["cap"]) / 1e9, 1e-2), color=SERIES[i], label=label)
    axes[0].axhline(d["disk_bytes"] / 1e12, color=MUTED, linewidth=0.8)
    axes[0].annotate("disk_bytes", (grid[0], d["disk_bytes"] / 1e12), xytext=(2, 3), textcoords="offset points", fontsize=7, color=MUTED)
    axes[0].set_title("Зайнято на диску, ТБ (пунктир: застарілі куски)", fontsize=9)
    axes[1].set_title("Активні куски", fontsize=9)
    axes[2].set_title("Межа розміру злиття, ГБ (нуль показано як 0.01)", fontsize=9)
    axes[2].set_yscale("log")
    for ax in axes:
        ax.set_xlabel("модельний час, хв")
    axes[0].set_ylim(bottom=0)
    axes[1].set_ylim(bottom=0)
    axes[1].legend(loc="upper left")
    fig.suptitle("Диск, що заповнюється: одна партиція, 100 вставок/с", x=0.01, ha="left", fontsize=10, color=INK, fontweight="bold")
    save(fig, "e11_disk")


def inputs():
    import csv
    from scipy import stats

    if not os.path.exists("runs/validation_open_0/inserts.csv") or not os.path.exists("runs/calibration_base/merges.npy"):
        return
    with open("calibration.json") as f:
        cal = json.load(f)["model"]
    arrivals = np.array(sorted(float(r["arrival"]) for r in csv.DictReader(open("runs/validation_open_0/inserts.csv"))))
    gaps = np.diff(arrivals)
    merges = np.load("runs/calibration_base/merges.npy")
    small = merges[:, 3] < cal["large_merge_bytes"]
    residual = np.log(merges[small, 0]) - np.log(cal["merge_fixed_seconds"] + merges[small, 3] / cal["merge_bytes_per_second"])
    # parameters come from the same sample, so plain kstest p-values are too high; goodness_of_fit refits per simulated sample
    ks_gaps = stats.goodness_of_fit(stats.expon, gaps, known_params={"loc": 0}, statistic="ks", random_state=0)
    ks_noise = stats.goodness_of_fit(stats.norm, residual, statistic="ks", random_state=0)
    fig, axes = plt.subplots(1, 2, figsize=(10, 3.6))
    ax = axes[0]
    ax.hist(gaps, bins=40, density=True, color=SERIES[0], alpha=0.7, label="виміряні інтервали")
    x = np.linspace(0, gaps.max(), 200)
    ax.plot(x, stats.expon.pdf(x, scale=gaps.mean()), color=SERIES[1], label="експоненційний закон")
    ax.set_title(f"Інтервали між вставками, сервер, 8/с: KS D = {ks_gaps.statistic:.3f}, p = {ks_gaps.pvalue:.2f}", fontsize=9)
    ax.set_xlabel("інтервал, с")
    ax.legend()
    ax = axes[1]
    (osm, osr), (slope, intercept, _) = stats.probplot(residual, dist="norm")
    ax.scatter(osm, osr, s=8, color=SERIES[0], label="залишки")
    ax.plot(osm, slope * osm + intercept, color=SERIES[1], label="нормальний закон")
    ax.set_title(f"Шум тривалості злиття, Q-Q: KS D = {ks_noise.statistic:.3f}, p = {ks_noise.pvalue:.4f}", fontsize=9)
    ax.set_xlabel("квантилі нормального закону")
    ax.set_ylabel("лог-залишок")
    ax.legend()
    save(fig, "inputs")
    with open(f"{SRC}/inputs.json", "w") as f:
        json.dump(dict(gaps=dict(n=len(gaps), mean=float(gaps.mean()), cv=float(gaps.std() / gaps.mean()), ks=ks_gaps.statistic, p=ks_gaps.pvalue),
                       merge_noise=dict(n=int(small.sum()), sigma=float(residual.std(ddof=1)), ks=ks_noise.statistic, p=ks_noise.pvalue,
                                        skew=float(stats.skew(residual)), excess_kurtosis=float(stats.kurtosis(residual)))), f, indent=1)


def validation():
    cases = [c for c in ("open", "closed", "throttled") if os.path.exists(f"runs/validation_{c}.json")]
    if not cases:
        return
    titles = {"open": "відкритий, 8/с", "closed": "8 замкнених клієнтів", "throttled": "40/с, низькі пороги гальмування"}
    metrics = list(METRIC_NAMES)
    fig, axes = plt.subplots(1, len(cases), figsize=(4.0 * len(cases) + 1.5, 3.8), sharey=True)
    axes = np.atleast_1d(axes)
    for ax, case in zip(axes, cases):
        with open(f"runs/validation_{case}.json") as f:
            rows = {r["metric"]: r for r in json.load(f)["comparison"]}
        for j, metric in enumerate(metrics):
            r = rows[metric]
            if not r["live"]:
                continue
            diff = (r["model"] / r["live"] - 1) * 100
            # relative half-widths add in quadrature
            half = 100 * r["model"] / r["live"] * np.hypot(r["model_half"] / r["model"] if r["model"] else 0, r["live_half"] / r["live"])
            ax.errorbar([diff], [j], xerr=[half], color=SERIES[0], marker="o", capsize=3)
            ax.annotate(f"{diff:+.1f}%", (diff, j), xytext=(0, 6), textcoords="offset points", ha="center", fontsize=7, color=INK2)
        ax.axvline(0, color=AXIS, linewidth=0.8)
        ax.set_yticks(range(len(metrics)), [METRIC_NAMES[m] for m in metrics])
        ax.set_ylim(len(metrics) - 0.5, -0.7)
        ax.set_title(titles[case], fontsize=9)
        ax.set_xlabel("модель відносно сервера, %")
    save(fig, "validation")


if __name__ == "__main__":
    for name, fn in (("e1_load", e1), ("e2_batch", e2), ("e3_boundary", e3), ("e4_selector", e4), ("e5_policy", e5),
                     ("e6_feedback", e6), ("e7_burst", e7), ("e9_factorial", e9), ("e10_partitions", e10), ("e11_disk", e11)):
        d = load(name)
        if d is not None:
            fn(d)
    validation()
    inputs()
