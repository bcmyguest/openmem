#!/usr/bin/env bash
# Pass watcher lines through; on FORMAT-FAIL of a first attempt, move it to invalid/ and queue one rerun.
B=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$B"
Q=${CTX_QUEUE:-ctx/queue.txt}  # reruns go to the queue the scheduler reads (run D: ctx/queue-D.txt)
while IFS= read -r line; do
  echo "$line"
  case "$line" in LINE:*) ;; *) continue;; esac
  run=$(awk '{print $2}' <<<"$line"); arm=$(awk '{print $3}' <<<"$line"); t=$(awk '{print $4}' <<<"$line"); seed=$(awk '{print $5}' <<<"$line" | tr -d :)
  l=$(grep "^$run $arm $t-$seed " ctx/done.txt | tail -1); read -r _ _ _ nm <<<"$l"
  if [ -n "$nm" ] && { [[ "$line" == *answered=* ]] || [[ "$line" == *max_steps* ]]; } && grep -qlE '"api_error_status":429|rate_limit_error' "results-$run/$arm/trials/$nm"/agent/*.jsonl 2>/dev/null; then
    mkdir -p "results-$run/$arm/rate-limited"; mv "results-$run/$arm/trials/$nm" "results-$run/$arm/rate-limited/"
    echo "$run $arm $t-$seed ${nm%.rl1}.rl1" | tee -a "$Q" >> ctx/reruns.txt
    echo "AUTO: 429 errors, moved $nm to rate-limited/ and requeued"; continue
  fi
  if [ -n "$nm" ] && grep -ql '"name":"openmem","status":"failed"' "results-$run/$arm/trials/$nm"/agent/cc-turn-*.jsonl 2>/dev/null; then
    echo "AUTO: WARNING openmem MCP failed to start in $nm; check before using this result"
  fi
  case "$line" in *FORMAT-FAIL*) ;; *) continue;; esac
  run=$(awk '{print $2}' <<<"$line"); arm=$(awk '{print $3}' <<<"$line"); t=$(awk '{print $4}' <<<"$line"); seed=$(awk '{print $5}' <<<"$line" | tr -d :)
  task="$t-$seed"
  l=$(grep "^$run $arm $task " ctx/done.txt | tail -1); read -r _ _ _ name <<<"$l"
  [[ -z "$name" || "$name" == *.rerun1 ]] && { echo "AUTO: no rerun for $run $arm $task ($name)"; continue; }
  grep -q "^$run $arm $task $name.rerun1$" "$Q" && continue
  mkdir -p "results-$run/$arm/invalid"; mv "results-$run/$arm/trials/$name" "results-$run/$arm/invalid/" 2>/dev/null
  echo "$run $arm $task $name.rerun1" | tee -a "$Q" >> ctx/reruns.txt
  echo "AUTO: queued rerun $name.rerun1"
done
