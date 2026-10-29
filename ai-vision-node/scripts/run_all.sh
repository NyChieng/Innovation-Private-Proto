#!/usr/bin/env bash
# Run the whole FloraGuard training chain one step at a time (never two jobs at once: the laptop
# runs out of commit memory when a training run shares it with anything big).
#   bash scripts/run_all.sh            -> logs/run_all.log, one "STEP" line per stage
cd "$(dirname "$0")/.." || exit 1
PY=.venv/Scripts/python
step() {
  echo "STEP $1 start $(date +%H:%M)" >> logs/run_all.log
  shift
  "$@" > "logs/step_$(date +%H%M%S).log" 2>&1
  rc=$?
  echo "STEP done rc=$rc $(date +%H:%M): $*" >> logs/run_all.log
  return $rc
}
mkdir -p logs
[ -f data/touch/manifest.csv ] || { step crops $PY scripts/make_touch_crops.py || exit 1; }
if [ ! -f runs/detect/det_B/weights/best.pt ]; then
  a_rows=$(( $(wc -l < runs/detect/det_A/results.csv 2>/dev/null || echo 1) - 1 ))
  if [ "$a_rows" -ge 10 ]; then step det_B $PY scripts/train.py det --stage b || exit 1   # stage A finished
  elif [ -f runs/detect/det_A/weights/last.pt ]; then step det $PY scripts/train.py det --resume det_A || exit 1
  else step det $PY scripts/train.py det || exit 1; fi
fi
step touch   $PY scripts/train.py touch || exit 1
step eval_det   $PY scripts/evaluate.py det
step eval_touch $PY scripts/evaluate.py touch
step speed      $PY scripts/evaluate.py speed
echo "ALL DONE $(date +%H:%M)" >> logs/run_all.log
