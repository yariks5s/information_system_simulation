# Імітаційна модель фонових злиттів MergeTree

Дискретно-подієва модель підсистеми фонових злиттів ClickHouse як системи масового обслуговування, черга якої гальмує власний вхідний потік. Повний опис моделі, калібрування, валідації й експериментів: [RFC.md](RFC.md).

## Що де лежить

| Шлях | Що це |
|---|---|
| `engine.py`, `inputs.py`, `pool.py`, `selector.py`, `throttle.py`, `model.py` | модель на Python |
| `stats.py` | ймовірнісно-часові характеристики, розігрів, репліки, довірчі інтервали |
| `loadgen.py`, `calibrate.py`, `validate.py` | навантаження на живий сервер ClickHouse, калібрування, валідація |
| `experiments.py`, `run_experiments.py`, `plots.py` | експерименти E1–E11 і графіки |
| `calibration.json`, `results/`, `runs/` | відкалібровані параметри, результати експериментів, дані валідації |
| `test_*.py` | тести Python-моделі |
| `open_questions.py` | перевірка гіпотез про розбіжності валідації |
| `app/` | інтерактивна лабораторія в браузері: [app/README.md](app/README.md) |
| `docs/` | однесторінковий план (`plan.md`, `plan.docx`) і звіт (`report.md`, `report.docx`, `report.pdf`); `docs/build.sh` перезбирає docx і pdf |

## Як запустити

    python3 -m pytest -q test_*.py              # тести моделі, близько 6 хвилин
    python3 run_experiments.py --quick e1_load   # швидка перевірка одного експерименту
    python3 run_experiments.py                   # усі експерименти, кілька годин на 32 ядрах
    python3 plots.py                             # графіки в results/

Лабораторія: відкрити `app/dist/index.html` у браузері.

Калібрування й валідація потребують окремого сервера ClickHouse: скопіювати Release-бінарник у `server/clickhouse` і запустити `server/clickhouse server --config-file=server/config.xml --daemon` (порти 19480 і 19481). Шляхи в конфігу абсолютні й розраховані на `/home/ubuntu/merge-sim`.
