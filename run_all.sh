#!/bin/bash
# after the live validation runs: model comparison, quick smoke of every experiment, full experiments, figures
set -e
cd "$(dirname "$0")"
until grep -q '^exit' runs/validation_throttled_live.log 2>/dev/null; do sleep 30; done
for c in open closed throttled; do
    python3 validate.py compare $c > runs/validation_${c}_compare.log 2>&1
done
python3 run_experiments.py --quick > runs/experiments_quick.log 2>&1
python3 plots.py --quick >> runs/experiments_quick.log 2>&1
python3 run_experiments.py > runs/experiments.log 2>&1
python3 plots.py >> runs/experiments.log 2>&1
echo done >> runs/experiments.log
