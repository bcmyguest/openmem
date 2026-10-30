#!/usr/bin/env bash
# ContextBench pilot: Claude Code (Harbor) on Claude Haiku 5.5, four compaction arms, run sequentially.
#
#   export CLAUDE_CODE_OAUTH_TOKEN=...      # from `claude setup-token` (one-time, see README below)
#   ./run_pilot.sh                          # pilot: kv-store-R2000-seed42 x 4 arms
#   SUBSET=1 ./run_pilot.sh                 # kv-store-R4000 + log-triage-L6400, seeds 42-44 x 4 arms
#   ARMS="a3b-trim" ./run_pilot.sh          # one arm
#   ./run_pilot.sh proxy-check              # start the bench proxy, probe /health/liveliness, remove it
#   ./run_pilot.sh summarize                # table from results/ (also printed after a run)
#
# Arms (every arm goes through the same benchmark-only LiteLLM container so token accounting is identical):
#   a1-none        proxy pass-through (CONTEXT_PROXY_ENABLED=0), DISABLE_AUTO_COMPACT=1
#   a2-native      proxy pass-through, Claude Code auto-compact with CLAUDE_CODE_AUTO_COMPACT_WINDOW=$NATIVE_WINDOW
#   a3a-trim-comp  OpenMem trim at $TRIM_AT + tool-result compression over 4000 tokens, DISABLE_AUTO_COMPACT=1
#   a3b-trim       OpenMem trim at $TRIM_AT, compression off (CONTEXT_COMPRESS_OVER_TOKENS=0), DISABLE_AUTO_COMPACT=1
#
# NATIVE_WINDOW=153000: model-config.md documents Haiku 5.5 auto-compacting "at about 967K" on its 1M window,
# i.e. ~33K below the window; the docs give no formula, so 153000 - 33000 = ~120000 is an inference that lines
# the native trigger up with the proxy's CONTEXT_TRIM_AT_TOKENS=120000. Check compact_boundary pre_tokens in
# the a2 summary row after the pilot and adjust NATIVE_WINDOW (allowed range 100000-1000000). Note the two
# thresholds count tokens differently (Claude Code: API token counts; proxy: its own estimate_tokens()).
#
# The bench proxy mounts the repo's proxy/ read-only, so it runs whatever is checked out in
# /home/brandonguest/personal-memory (merge the first-user-message pinning fix before the run).
# PIN_INSTRUCTION=true moves the task statement into --append-system-prompt-file (old workaround; default off).
# It never touches the `openmem` compose project: container cbench-proxy, port 172.17.0.1:4200.
set -euo pipefail

B=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$B"
REPO_PROXY=/home/brandonguest/personal-memory/proxy
IMAGE=${IMAGE:-ghcr.io/berriai/litellm:v1.106.6}   # same tag as the repo's compose.yaml context-proxy
NAME=cbench-proxy
HOST_IP=${HOST_IP:-172.17.0.1}                    # docker0 gateway: reachable from Harbor's task networks
PORT=${PORT:-4200}
BASE_URL="http://$HOST_IP:$PORT"
MODEL=${MODEL:-anthropic/claude-haiku-5-5}
WINDOW=${WINDOW:-1000000}                         # ContextBench budget wall = model window
TRIM_AT=${TRIM_AT:-120000}
COMPRESS_AT=${COMPRESS_AT:-4000}
NATIVE_WINDOW=${NATIVE_WINDOW:-153000}
PIN_INSTRUCTION=${PIN_INSTRUCTION:-false}
CC_VERSION=${CC_VERSION:-}                        # e.g. 2.1.300 to pin Claude Code across arms; empty = latest
ARMS=${ARMS:-"a1-none a2-native a3a-trim-comp a3b-trim"}
if [ "${SUBSET:-0}" = 1 ]; then
  TASKS=${TASKS:-"$(for t in kv-store-R4000 log-triage-L6400; do for s in 42 43 44; do printf '%s-seed%s ' "$t" "$s"; done; done)"}
else
  TASKS=${TASKS:-kv-store-R2000-seed42}
fi
ENV_FILE=$B/state/bench.env
RESULTS=$B/results

ensure_key() {
  mkdir -p -m 700 "$B/state"
  if [ ! -s "$ENV_FILE" ]; then
    (umask 077; printf 'LITELLM_MASTER_KEY=sk-bench-%s\n' "$(openssl rand -hex 24)" > "$ENV_FILE")
  fi
  chmod 600 "$ENV_FILE"
}

proxy_down() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }

proxy_up() {  # $1 arm, $2 CONTEXT_PROXY_ENABLED, $3 CONTEXT_COMPRESS_OVER_TOKENS
  local arm=$1
  proxy_down
  mkdir -p -m 700 "$B/state/$arm/context"
  mkdir -p "$RESULTS/$arm"
  docker run -d --name "$NAME" --label cbench=1 \
    -p "$HOST_IP:$PORT:4000" --user "$(id -u):$(id -g)" \
    --env-file "$ENV_FILE" \
    -e HOME=/tmp -e PYTHONDONTWRITEBYTECODE=1 -e PYTHONPATH=/app/proxy \
    -e OPENMEM_STATE_DIR=/state -e HINDSIGHT_URL=http://127.0.0.1:9 \
    -e CONTEXT_PROXY_ENABLED="$2" -e CONTEXT_TRIM_AT_TOKENS="$TRIM_AT" -e CONTEXT_COMPRESS_OVER_TOKENS="$3" \
    -e BENCH_ARM="$arm" -e BENCH_USAGE_LOG=/results/usage.jsonl \
    -v "$REPO_PROXY:/app/proxy:ro" -v "$B/litellm:/app/bench:ro" \
    -v "$B/state/$arm:/state" -v "$RESULTS/$arm:/results" \
    "$IMAGE" --config /app/bench/bench-config.yaml --port 4000 --num_workers 1 >/dev/null
  local i
  for i in $(seq 60); do
    curl -fsS "$BASE_URL/health/liveliness" >/dev/null 2>&1 && return 0
    sleep 2
  done
  docker logs --tail 50 "$NAME" >&2
  echo "bench proxy did not become live" >&2
  return 1
}

proxy_check() {  # liveliness from the host and from a container on a fresh bridge network (like Harbor's)
  ensure_key
  trap proxy_down EXIT
  proxy_up check 0 0
  echo "host: $(curl -fsS "$BASE_URL/health/liveliness")"
  docker network create cbench-probe >/dev/null
  docker run --rm --network cbench-probe curlimages/curl:latest -fsS --max-time 10 "$BASE_URL/health/liveliness" \
    | sed 's/^/bridge container: /' || echo "bridge container: UNREACHABLE"
  docker network rm cbench-probe >/dev/null
  docker logs "$NAME" 2>&1 | grep -iE "error|traceback|callback" | head -20 || true
  rm -rf "$B/state/check" "$RESULTS/check"
}

trial() {  # $1 arm, $2 task, rest: --ae flags
  local arm=$1 task=$2; shift 2
  local extra=()
  [ -n "$CC_VERSION" ] && extra+=(--agent-kwarg "version=$CC_VERSION")
  # ${VAR} templates: Harbor resolves them from this process's env and persists the template, not the secret
  PYTHONPATH=$B "$B/.venv/bin/harbor" trial start -p "cb/tasks/$task" -e docker \
    -a cc_stream:ClaudeCodeStream -m "$MODEL" \
    --trials-dir "$RESULTS/$arm/trials" --trial-name "$arm.$task" \
    --agent-kwarg context_budget_tokens="$WINDOW" --agent-kwarg pin_instruction="$PIN_INSTRUCTION" \
    "${extra[@]}" \
    --ae 'CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN}' \
    --ae "ANTHROPIC_BASE_URL=$BASE_URL" \
    --ae 'ANTHROPIC_CUSTOM_HEADERS=${BENCH_CC_HEADERS}' \
    "$@" || echo "trial $arm.$task exited non-zero" >&2
}

run_arm() {  # $1 arm, $2 proxy enabled, $3 compress, rest: --ae flags
  local arm=$1 en=$2 comp=$3 t; shift 3
  proxy_up "$arm" "$en" "$comp"
  export BENCH_CC_HEADERS
  BENCH_CC_HEADERS="$(printf 'x-litellm-api-key: Bearer %s\nx-bench-arm: %s' \
    "$(sed -n 's/^LITELLM_MASTER_KEY=//p' "$ENV_FILE")" "$arm")"
  for t in $TASKS; do
    trial "$arm" "$t" "$@"
  done
  docker logs "$NAME" > "$RESULTS/$arm/proxy.log" 2>&1 || true
  proxy_down
}

main() {
  : "${CLAUDE_CODE_OAUTH_TOKEN:?export CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) first}"
  ensure_key
  trap proxy_down EXIT
  local arm
  for arm in $ARMS; do
    case $arm in
      a1-none)       run_arm "$arm" 0 0              --ae DISABLE_AUTO_COMPACT=1 ;;
      a2-native)     run_arm "$arm" 0 0              --ae CLAUDE_CODE_AUTO_COMPACT_WINDOW="$NATIVE_WINDOW" ;;
      a3a-trim-comp) run_arm "$arm" 1 "$COMPRESS_AT" --ae DISABLE_AUTO_COMPACT=1 ;;
      a3b-trim)      run_arm "$arm" 1 0              --ae DISABLE_AUTO_COMPACT=1 ;;
      *) echo "unknown arm $arm" >&2; exit 2 ;;
    esac
  done
  "$B/.venv/bin/python" "$B/summarize.py" "$RESULTS" | tee "$RESULTS/summary.md"
}

case "${1:-run}" in
  run) main ;;
  proxy-check) proxy_check ;;
  summarize) "$B/.venv/bin/python" "$B/summarize.py" "$RESULTS" ;;
  *) echo "usage: $0 [run|proxy-check|summarize]" >&2; exit 2 ;;
esac
