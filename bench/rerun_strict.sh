#!/usr/bin/env bash
# Rerun format-invalid trials (kv answers right except the dropped #tag), in parallel (<= 4 at once).
set -euo pipefail
B=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source <(sed -n '/^REPO=/,/^pname()/p' "$B/run_strict.sh")
source <(sed -n '/^load_token()/,/^}/p;/^arm_headers()/,/^}/p;/^arm_flags()/,/^}/p;/^trial()/,/^}/p' "$B/run_strict.sh")
cd "$B"; load_token
while read -r arm task; do
  trial "$arm" "$task" "$RESULTS/$arm/trials" "$arm.$task.rerun1" > "$RESULTS/$arm/rerun-$task.log" 2>&1 &
done <<'LIST'
s1-none kv-store-R4000-seed43

s3a-smart kv-store-R4000-seed43
LIST
wait
