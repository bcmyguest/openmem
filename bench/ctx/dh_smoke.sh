#!/usr/bin/env bash
# One d-hybrid smoke trial on repo-Dh: Dsmoke settings (trim 20000, port 4254), own results-Dhsmoke/state-Dhsmoke.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
source <(sed "/^case \"\${1:-}\" in/,\$d" ./run_ctx.sh)
setrun Dsmoke; RESULTS=$B/results-Dhsmoke; STATE=$B/state-Dhsmoke; load_token
proxy_up d-hybrid; ARMS=d-hybrid; wait_live
arm=d-hybrid task=kv-store-R1000-seed42; name=Dhsmoke-d-hybrid.$task
mkdir -p "$RESULTS/$arm/trials"
trial "$arm" "$task" "$RESULTS/$arm/trials" "$name" > "$RESULTS/$arm/$name.log" 2>&1
docker logs "$(pname "$arm")" > "$RESULTS/$arm/proxy.log" 2>&1 || true
docker rm -f "$(pname "$arm")" >/dev/null
echo "smoke done"
