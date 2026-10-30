#!/usr/bin/env bash
# Emit one LINE per newly finished trial (ctx/done.txt), remembering progress in ctx/reported.n.
B=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$B"; touch ctx/done.txt; [ -f ctx/reported.n ] || echo 0 > ctx/reported.n
while true; do
  n=$(cat ctx/reported.n); total=$(wc -l < ctx/done.txt)
  while [ "$n" -lt "$total" ]; do
    n=$((n+1)); read -r run arm task name < <(sed -n "${n}p" ctx/done.txt)
    if [ -f "results-$run/$arm/trials/$name/result.json" ]; then
      .venv/bin/python ctx_metrics.py trial "results-$run" "state-$run" "$arm" "$name" 2>&1 | tail -1
    else echo "LINE: $run $arm $task: NO result.json ($name)"; fi
    echo "$n" > ctx/reported.n
  done
  pgrep -f ctx_sched.py >/dev/null || { echo "SCHEDULER EXITED"; exit 0; }
  sleep 15
done
