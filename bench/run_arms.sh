#!/usr/bin/env bash
# DRAFT, NOT EXECUTED. ContextBench x {no compaction, Claude Code auto-compact, OpenMem proxy +/- compression}.
# Every arm: Harbor 0.16.1 + Docker + Claude Code (cc_stream.py) on Claude Haiku, subscription OAuth.
# Every arm routes through a benchmark-only LiteLLM container (project "cbench", port 4200 on docker0),
# never the running "openmem" compose project. Arms 1-2 run it with CONTEXT_PROXY_ENABLED=0 so token
# accounting is identical across arms.
set -euo pipefail

B=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$B"
PY=$B/.venv/bin
MODEL=${MODEL:-anthropic/claude-haiku-5-5}        # or anthropic/claude-haiku-4-5 (200k window): user decision
WINDOW=${WINDOW:-1000000}                          # ContextBench wall = model window (200000 for Haiku 4.5)
SEEDS=${SEEDS:-"42 43 44"}
TASKS=${TASKS:-"kv-store-R4000 log-triage-L6400"}
PILOT=${PILOT:-1}                                  # 1: kv-store-R2000-seed42 only, all arms

# ---------------------------------------------------------------- 0. one-time setup (scratch only)
setup() {
  # Harbor already installed: uv venv .venv -p 3.12 && uv pip install harbor==0.16.1 tiktoken
  VIRTUAL_ENV=$B/.venv uv pip install "./cb[tokenizer,harbor]"   # ContextBench (blocked once as editable; retry non-editable)
  # Long-lived subscription token for containers (interactive, user runs it): claude setup-token
  : "${CLAUDE_CODE_OAUTH_TOKEN:?run 'claude setup-token' and export CLAUDE_CODE_OAUTH_TOKEN}"
  mkdir -p -m 700 "$B/state/context" "$B/logs"
  export LITELLM_MASTER_KEY=${LITELLM_MASTER_KEY:-$(openssl rand -hex 24)}
  echo "$LITELLM_MASTER_KEY" > "$B/state/litellm.key"; chmod 600 "$B/state/litellm.key"
}

# --------------------------------------------- 1. benchmark proxy (same image as the repo's compose)
proxy_up() {  # $1 = CONTEXT_PROXY_ENABLED, $2 = CONTEXT_COMPRESS_OVER_TOKENS
  docker rm -f cbench-proxy >/dev/null 2>&1 || true
  docker run -d --name cbench-proxy --label com.docker.compose.project=cbench \
    -p 172.17.0.1:4200:4000 --user "$(id -u):$(id -g)" \
    -e LITELLM_MASTER_KEY="$(cat "$B/state/litellm.key")" \
    -e CONTEXT_PROXY_ENABLED="$1" -e CONTEXT_COMPRESS_OVER_TOKENS="$2" \
    -e CONTEXT_TRIM_AT_TOKENS="${TRIM_AT:-120000}" \
    -e OPENMEM_STATE_DIR=/state -e BENCH_USAGE_LOG=/logs/usage.jsonl \
    -v "$B/proxy:/app/bench:ro" -v "$B/state:/state" -v "$B/logs:/logs" \
    ghcr.io/berriai/litellm:v1.106.6 --config /app/bench/bench-config.yaml --port 4000 --num_workers 1
  # no ANTHROPIC_API_KEY in this container: Claude Code's OAuth passes through (docs/context-proxy.md)
  until curl -fsS http://172.17.0.1:4200/health/liveliness >/dev/null; do sleep 2; done
}

# ------------------------------------------------------------------- 2. one trial
trial() {  # $1 arm label, $2 task dir name, rest: extra --ae flags
  local arm=$1 task=$2; shift 2
  PYTHONPATH=$B "$PY/harbor" trial start -p "cb/tasks/$task" -e docker \
    -a cc_stream:ClaudeCodeStream -m "$MODEL" \
    --trials-dir "$B/trials/$arm" --trial-name "$arm-$task" \
    --agent-kwarg context_budget_tokens="$WINDOW" \
    --ae CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" \
    --ae ANTHROPIC_BASE_URL=http://172.17.0.1:4200 \
    --ae ANTHROPIC_CUSTOM_HEADERS="$(printf 'x-litellm-api-key: Bearer %s\nx-bench-arm: %s' "$(cat "$B/state/litellm.key")" "$arm")" \
    "$@"
}

run_arm() {  # $1 arm, $2 proxy enabled, $3 compress, rest: --ae flags
  local arm=$1 en=$2 comp=$3; shift 3
  proxy_up "$en" "$comp"
  if [ "$PILOT" = 1 ]; then trial "$arm" kv-store-R2000-seed42 "$@"; return; fi
  for t in $TASKS; do for s in $SEEDS; do trial "$arm" "$t-seed$s" "$@"; done; done
}

# --------------------------------------------------------------------------- arms
# A1 no compaction: Claude Code auto-compact off, proxy pass-through.
run_arm a1-none        0 0    --ae DISABLE_AUTO_COMPACT=1
# A2 native: Claude Code's own auto-compact. With Haiku 5.5 (1M) it would never fire on these
# streams, so pin its window; calibrate in the pilot so the trigger lands near the proxy's 120k.
run_arm a2-native      0 0    --ae CLAUDE_CODE_AUTO_COMPACT_WINDOW="${NATIVE_WINDOW:-150000}"
# A3a OpenMem trim + tool-result compression (shipped defaults).
run_arm a3-trim-comp   1 4000 --ae DISABLE_AUTO_COMPACT=1
# A3b OpenMem trim only.
run_arm a3-trim        1 0    --ae DISABLE_AUTO_COMPACT=1
docker rm -f cbench-proxy

# ------------------------------------------------------------------- 3. summarize
# Rewards: trials/<arm>/<trial>/verifier/reward.json (ContextBench grader: reward, n_answered, peak tokens).
# Tokens: logs/usage.jsonl rows (arm, input/cache_read/cache_creation/output per request); price with
# estimate.py's PRICE table. Cross-check: Claude Code stream-json "result" events in trials/*/agent/cc-turn-*.jsonl.
