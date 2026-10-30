#!/usr/bin/env bash
# Strict ContextBench comparison of OpenMem smart compaction: four arms in parallel, Claude Haiku 5.5 via
# Claude Code (Harbor), no shell/file/agent tools. Results under results-strict/, state under state-strict/.
#
#   ./run_strict.sh up            # start the four bench proxies (ports 4201-4204)
#   ./run_strict.sh smoke         # one ~3-turn trial per arm, in parallel, into results-strict-smoke/
#   ./run_strict.sh run           # 6 tasks x 4 arms, one Harbor job per arm (-n $N_PER_ARM), then retry + summary
#   ./run_strict.sh retry         # re-run once every trial that failed before any model call
#   ./run_strict.sh summarize
#   ./run_strict.sh down          # save proxy logs, remove the proxies
#
# Arms (one LiteLLM bench proxy each, so trim settings and usage logs are per arm):
#   s1-none           proxy pass-through, DISABLE_AUTO_COMPACT=1
#   s2-native         proxy pass-through, CLAUDE_CODE_AUTO_COMPACT_WINDOW=$NATIVE_WINDOW (fired at ~120k in the pilot)
#   s3a-smart         proxy trim at $TRIM_AT + tool-result compression over $COMPRESS_AT, DISABLE_AUTO_COMPACT=1, OpenMem MCP
#   s3b-smart-nocomp  proxy trim at $TRIM_AT, compression off, DISABLE_AUTO_COMPACT=1, OpenMem MCP
# Strict (cc_stream.py strict=true): `--tools ""`, --disallowedTools $DENY, --strict-mcp-config; readiness from
# the reply text. s3 arms get only mcp__openmem__smart_compact_search/_get (other openmem tools disallowed).
# Never touches the `openmem` compose project.
set -euo pipefail

B=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$B"
REPO=$(dirname "$B")
IMAGE=${IMAGE:-ghcr.io/berriai/litellm:v1.106.6}
HOST_IP=${HOST_IP:-172.17.0.1}
MODEL=${MODEL:-anthropic/claude-haiku-5-5}
WINDOW=${WINDOW:-1000000}
TRIM_AT=${TRIM_AT:-120000}
COMPRESS_AT=${COMPRESS_AT:-4000}
NATIVE_WINDOW=${NATIVE_WINDOW:-153000}
N_PER_ARM=${N_PER_ARM:-2}
ARMS=${ARMS:-"s1-none s2-native s3a-smart s3b-smart-nocomp"}
TASKS=${TASKS:-"$(for t in kv-store-R4000 log-triage-L6400; do for s in 42 43 44; do printf '%s-seed%s ' "$t" "$s"; done; done)"}
SMOKE_TASK=${SMOKE_TASK:-kv-store-R4000-seed42}
SMOKE_STEPS=${SMOKE_STEPS:-3}
ENV_FILE=$B/state/bench.env
RESULTS=${RESULTS:-$B/results-strict}
STATE=$B/state-strict
DENY_BUILTIN="Bash,Write,Edit,MultiEdit,NotebookEdit,NotebookRead,Read,Glob,Grep,LS,Task,Agent,WebFetch,WebSearch"
DENY_BUILTIN+=",TodoWrite,BashOutput,KillShell,KillBash,Skill,SlashCommand,ToolSearch,ExitPlanMode,EnterPlanMode"
DENY_BUILTIN+=",ListMcpResourcesTool,ReadMcpResourceTool,Monitor,TaskOutput,TaskStop,EnterWorktree,ExitWorktree"
DENY_MCP="" # every openmem tool except the two smart_compact ones
for t in project_scope add search recall forget export import provider_status reflect consolidate \
         pages_list pages_search pages_read capture_initiative status; do DENY_MCP+=",mcp__openmem__memory_$t"; done

port() { case $1 in s1-none) echo 4201;; s2-native) echo 4202;; s3a-smart) echo 4203;; s3b-smart-nocomp) echo 4204;;
         *) echo "unknown arm $1" >&2; exit 2;; esac; }
pname() { echo "cbench-$1"; }

load_token() {
  if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -s "$B/state/oauth-token" ]; then
    CLAUDE_CODE_OAUTH_TOKEN="$(head -n1 "$B/state/oauth-token")"; export CLAUDE_CODE_OAUTH_TOKEN
  fi
  : "${CLAUDE_CODE_OAUTH_TOKEN:?no oauth token in state/oauth-token}"
  [ -s "$ENV_FILE" ] || { echo "missing $ENV_FILE" >&2; exit 1; }
}

proxy_up() {  # $1 arm
  local arm=$1 en=0 comp=0 p; p=$(port "$arm")
  case $arm in s3a-smart) en=1; comp=$COMPRESS_AT;; s3b-smart-nocomp) en=1;; esac
  docker rm -f "$(pname "$arm")" >/dev/null 2>&1 || true
  mkdir -p -m 700 "$STATE/$arm/context"
  mkdir -p "$RESULTS/$arm"
  docker run -d --name "$(pname "$arm")" --label cbench=1 \
    -p "$HOST_IP:$p:4000" --user "$(id -u):$(id -g)" --env-file "$ENV_FILE" \
    -e HOME=/tmp -e PYTHONDONTWRITEBYTECODE=1 -e PYTHONPATH=/app/proxy \
    -e OPENMEM_STATE_DIR=/state -e HINDSIGHT_URL=http://127.0.0.1:9 \
    -e CONTEXT_PROXY_ENABLED="$en" -e CONTEXT_TRIM_AT_TOKENS="$TRIM_AT" -e CONTEXT_COMPRESS_OVER_TOKENS="$comp" \
    -e BENCH_ARM="$arm" -e BENCH_USAGE_LOG=/results/usage.jsonl \
    -v "$REPO/proxy:/app/proxy:ro" -v "$B/litellm:/app/bench:ro" \
    -v "$STATE/$arm:/state" -v "$RESULTS/$arm:/results" \
    "$IMAGE" --config /app/bench/bench-config.yaml --port 4000 --num_workers 1 >/dev/null
}

wait_live() {
  local arm i
  for arm in $ARMS; do
    for i in $(seq 60); do
      curl -fsS "http://$HOST_IP:$(port "$arm")/health/liveliness" >/dev/null 2>&1 && break
      [ "$i" = 60 ] && { docker logs --tail 40 "$(pname "$arm")" >&2; echo "$arm proxy not live" >&2; exit 1; }
      sleep 2
    done
    echo "$arm proxy live on $(port "$arm")"
  done
}

up() { local arm; for arm in $ARMS; do proxy_up "$arm"; done; wait_live; }

down() {
  local arm
  for arm in $ARMS; do
    docker logs "$(pname "$arm")" > "$RESULTS/$arm/proxy.log" 2>&1 || true
    docker rm -f "$(pname "$arm")" >/dev/null 2>&1 || true
  done
}

arm_headers() {  # x-litellm-api-key + x-bench-arm, newline separated (ANTHROPIC_CUSTOM_HEADERS)
  printf 'x-litellm-api-key: Bearer %s\nx-bench-arm: %s' "$(sed -n 's/^LITELLM_MASTER_KEY=//p' "$ENV_FILE")" "$1"
}

# common Harbor flags for an arm, into the global array FLAGS
arm_flags() {
  local arm=$1 deny=$DENY_BUILTIN
  FLAGS=(-e docker -a cc_stream:ClaudeCodeStream -m "$MODEL"
    --agent-kwarg context_budget_tokens="$WINDOW" --agent-kwarg strict=true
    --ae 'CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN}'
    --ae "ANTHROPIC_BASE_URL=http://$HOST_IP:$(port "$arm")"
    --ae 'ANTHROPIC_CUSTOM_HEADERS=${BENCH_CC_HEADERS}'
    --ae ENABLE_TOOL_SEARCH=false)
  case $arm in
    s2-native) FLAGS+=(--ae CLAUDE_CODE_AUTO_COMPACT_WINDOW="$NATIVE_WINDOW") ;;
    *)         FLAGS+=(--ae DISABLE_AUTO_COMPACT=1) ;;
  esac
  case $arm in
    s3a-smart|s3b-smart-nocomp)
      deny+=$DENY_MCP
      FLAGS+=(--agent-kwarg openmem_mcp=true --mounts "$(printf '[%s,%s,%s]' \
        "{\"type\":\"bind\",\"source\":\"$REPO\",\"target\":\"/repo\",\"read_only\":true}" \
        "{\"type\":\"bind\",\"source\":\"$B/node\",\"target\":\"/opt/node\",\"read_only\":true}" \
        "{\"type\":\"bind\",\"source\":\"$STATE/$arm\",\"target\":\"/state\",\"read_only\":true}")") ;;
  esac
  FLAGS+=(--agent-kwarg disallowed_tools="$deny")
}

job() {  # $1 arm: one Harbor job, all tasks, N_PER_ARM concurrent trials
  local arm=$1 t inc=()
  for t in $TASKS; do inc+=(-i "$t"); done
  arm_flags "$arm"
  BENCH_CC_HEADERS="$(arm_headers "$arm")" PYTHONPATH=$B "$B/.venv/bin/harbor" jobs start -y -q \
    -p cb/tasks "${inc[@]}" -o "$RESULTS/$arm" --job-name trials -n "$N_PER_ARM" --max-retries 0 \
    "${FLAGS[@]}" > "$RESULTS/$arm/job.log" 2>&1 || echo "job $arm exited non-zero" >&2
}

trial() {  # $1 arm, $2 task, $3 trials dir, $4 trial name, rest: extra flags
  local arm=$1 task=$2 dir=$3 name=$4; shift 4
  arm_flags "$arm"
  BENCH_CC_HEADERS="$(arm_headers "$arm")" PYTHONPATH=$B "$B/.venv/bin/harbor" trial start \
    -p "cb/tasks/$task" --trials-dir "$dir" --trial-name "$name" "${FLAGS[@]}" "$@" \
    || echo "trial $name exited non-zero" >&2
}

smoke() {
  local arm out=$B/results-strict-smoke
  mkdir -p "$out"
  for arm in $ARMS; do
    trial "$arm" "$SMOKE_TASK" "$out/$arm" "$arm.smoke" --agent-kwarg max_steps="$SMOKE_STEPS" \
      > "$out/$arm.log" 2>&1 &
  done
  wait
  "$B/.venv/bin/python" "$B/strict_check.py" smoke "$out" "$RESULTS"
}

retry() {  # trials that failed before any model call, once each
  local arm task name
  while read -r arm task name; do
    [ -n "$arm" ] || continue
    mkdir -p "$RESULTS/$arm/failed"
    mv "$RESULTS/$arm/trials/$name" "$RESULTS/$arm/failed/"
    echo "retrying $arm $task (was $name)"
    trial "$arm" "$task" "$RESULTS/$arm/trials" "$arm.$task.retry1" >> "$RESULTS/$arm/retry.log" 2>&1
  done < <("$B/.venv/bin/python" "$B/strict_check.py" no-model-calls "$RESULTS")
}

summarize() { "$B/.venv/bin/python" "$B/summarize.py" "$RESULTS" "$STATE" | tee "$RESULTS/summary.md"; }

run() {
  local arm
  for arm in $ARMS; do job "$arm" & done
  wait
  retry
  summarize
}

case "${1:-}" in
  up) load_token; up ;;
  down) down ;;
  smoke) load_token; smoke ;;
  run) load_token; run ;;
  retry) load_token; retry ;;
  summarize) summarize ;;
  *) echo "usage: $0 up|smoke|run|retry|summarize|down" >&2; exit 2 ;;
esac
