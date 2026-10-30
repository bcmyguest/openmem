#!/usr/bin/env bash
# ContextBench runs A and B against repo commit 788010a (standing search instruction, firmer pointer,
# line_matches). Same arms, model, strict flags and trim settings as run_strict.sh; its functions are
# sourced from there. Per run: results-<RUN>/, state-<RUN>/, proxies cbench-<run>-<arm>.
#
#   ./run_ctx.sh up A|B          start that run's proxies
#   ./run_ctx.sh down A|B        save proxy logs, remove that run's proxies
#   ./run_ctx.sh one RUN ARM TASK NAME   one trial (called by ctx_sched.py), appends to ctx/done.txt
#   ./run_ctx.sh summarize A|B
#
# Run C (semantic-arms.md): arms s3c-semantic (design a, semantic smart_compact_search) and s3d-recall (design b,
# Stop hook + memory_recall) against repo commit eb1e574 ($B/repo-eb1e574), provider Hindsight in compose project
# cbench-mem (http://$HOST_IP:18988). Run C's s3c arm is s3c-semantic-nudged: s3c-semantic plus the $NUDGE line. Csmoke = the same arms with TRIM_AT=20000, own proxies, results-Csmoke/.
#   ./run_ctx.sh smoke Csmoke ARM [TASK]   one trial, default kv-store-R1000-seed42
#
# Run D: OpenMem's SQLite context store (sessions/<sid>.db) at commit $D_SHA, exported to $R_D with its own
# `npm ci --omit=dev` node_modules, MCP on Node 24 ($B/node24), proxy image $D_IMAGE. Arms, strict like s3a-smart
# (trim at $TRIM_AT, compression over $COMPRESS_AT), tools smart_compact_search/_get/_sql only:
#   d-sqlite   vectors off
#   d-hybrid   vectors on: $D_EMB_MODEL at $D_EMB_URL (container cbench-ollama), in the proxy and the MCP
# Dsmoke = the same arms with TRIM_AT=20000, own proxies, results-Dsmoke/.
#   ./run_ctx.sh prep D            export $D_SHA to $R_D (replacing it) and npm ci there
# Run Dp: d-sqlite only at $DP_SHA in $R_DP (results-Dp/, state-Dp/); `./run_ctx.sh prep Dp` exports it.
#   ./run_ctx.sh ollama up|down    the bench Ollama (cbench-ollama, $D_EMB_MODEL pulled), port $D_EMB_PORT
#   ./run_ctx.sh smoke Dsmoke ARM [TASK]
set -euo pipefail
B=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$B"
source <(sed -n '/^REPO=/,/^pname()/p' "$B/run_strict.sh")
source <(sed -n '/^load_token()/,/^}/p;/^proxy_up()/,/^}/p;/^arm_headers()/,/^}/p;/^arm_flags()/,/^}/p;/^trial()/,/^}/p' "$B/run_strict.sh")

setrun() {
  RUN=$1
  RESULTS=$B/results-$RUN
  STATE=$B/state-$RUN
  case $RUN in A) ARMS="s3a-smart s3b-smart-nocomp";; B) ARMS="s1-none s2-native s3a-smart";;
    C) ARMS="s3c-semantic-nudged s3d-recall";;
    Csmoke) ARMS="s3c-semantic s3d-recall";;
    D|Dsmoke) ARMS="d-sqlite d-hybrid";;
    Dp) ARMS="d-sqlite";;
    *) echo "unknown run $RUN" >&2; exit 2;; esac
  [ "$RUN" = Csmoke ] && TRIM_AT=20000
  [ "$RUN" = Dsmoke ] && TRIM_AT=20000
  [ "$RUN" = Dp ] && TRIM_AT=  # as run D: the proxy's per-model threshold
  return 0
}
port() {
  case "$RUN:$1" in
    A:s3a-smart) echo 4223;; A:s3b-smart-nocomp) echo 4224;;
    B:s1-none) echo 4231;; B:s2-native) echo 4232;; B:s3a-smart) echo 4233;;
    C:s3c-semantic) echo 4241;; C:s3d-recall) echo 4242;; C:s3c-semantic-nudged) echo 4247;;
    Csmoke:s3c-semantic) echo 4243;; Csmoke:s3d-recall) echo 4244;; Csmoke:s3c-semantic-nudged) echo 4248;;
    D:d-sqlite) echo 4251;; D:d-hybrid) echo 4252;; Dsmoke:d-sqlite) echo 4253;; Dsmoke:d-hybrid) echo 4254;;
    Dp:d-sqlite) echo 4255;;
    *) echo "no port for $RUN $1" >&2; exit 2;;
  esac
}
pname() { echo "cbench-${RUN,,}-$1"; }

# Run C arms: eb1e574's proxy code and MCP, the cbench-mem Hindsight. Other arms keep run_strict.sh's functions.
R_C=$B/repo-eb1e574
SEM_URL=http://$HOST_IP:18988
NUDGE='Prefer smart_compact_search mode "semantic" for questions about earlier content.'
eval "$(declare -f proxy_up | sed '1s/^proxy_up /proxy_up_strict /')"
eval "$(declare -f arm_flags | sed '1s/^arm_flags /arm_flags_strict /')"

proxy_up() {
  case $1 in s3c-semantic|s3c-semantic-nudged|s3d-recall) proxy_up_c "$1" ;; d-*) proxy_up_d "$1" ;;
    *) proxy_up_strict "$@" ;; esac
}
proxy_up_c() {  # as s3a-smart (trim at $TRIM_AT, compression over $COMPRESS_AT); s3d: no standing instruction
  local arm=$1 p si=(); p=$(port "$arm")
  [ "$arm" = s3d-recall ] && si=(-e CONTEXT_STANDING_INSTRUCTION=0)
  docker rm -f "$(pname "$arm")" >/dev/null 2>&1 || true
  mkdir -p -m 700 "$STATE/$arm/context"
  mkdir -p "$RESULTS/$arm"
  docker run -d --name "$(pname "$arm")" --label cbench=1 \
    -p "$HOST_IP:$p:4000" --user "$(id -u):$(id -g)" --env-file "$ENV_FILE" \
    -e HOME=/tmp -e PYTHONDONTWRITEBYTECODE=1 -e PYTHONPATH=/app/proxy \
    -e OPENMEM_STATE_DIR=/state -e HINDSIGHT_URL=http://127.0.0.1:9 \
    -e CONTEXT_PROXY_ENABLED=1 -e CONTEXT_TRIM_AT_TOKENS="$TRIM_AT" -e CONTEXT_COMPRESS_OVER_TOKENS="$COMPRESS_AT" \
    "${si[@]}" -e BENCH_ARM="$arm" -e BENCH_USAGE_LOG=/results/usage.jsonl \
    -v "$R_C/proxy:/app/proxy:ro" -v "$B/litellm:/app/bench:ro" \
    -v "$STATE/$arm:/state" -v "$RESULTS/$arm:/results" \
    "$IMAGE" --config /app/bench/bench-config.yaml --port 4000 --num_workers 1 >/dev/null
}

arm_flags() {
  case $1 in s3c-semantic|s3c-semantic-nudged|s3d-recall) arm_flags_c "$1" ;; d-*) arm_flags_d "$1" ;;
    *) arm_flags_strict "$@" ;; esac
}
arm_flags_c() {  # strict base flags (no s3 case matches), then the arm's MCP, mounts and tool policy
  local arm=$1 deny=$DENY_BUILTIN ro=true
  arm_flags_strict "$arm"
  unset 'FLAGS[-1]' 'FLAGS[-1]'  # drop the trailing --agent-kwarg disallowed_tools=$DENY_BUILTIN pair
  FLAGS+=(--agent-kwarg openmem_mcp=true)
  case $arm in
    s3c-semantic|s3c-semantic-nudged)  # state read-write: the MCP writes sessions/<sid>.ingest.json and .ingest.lock
      ro=false; deny+=$DENY_MCP
      FLAGS+=(--agent-kwarg "mcp_env={\"CONTEXT_SEMANTIC_INGEST\":\"1\",\"HINDSIGHT_URL\":\"$SEM_URL\",\"CONTEXT_SEMANTIC_BANK\":\"cbench-s3c-{sid8}\"}")
      [ "$arm" = s3c-semantic-nudged ] && FLAGS+=(--agent-kwarg "extra_note=$NUDGE")
      ;;
    s3d-recall)
      deny+=${DENY_MCP/,mcp__openmem__memory_recall/},mcp__openmem__smart_compact_search,mcp__openmem__smart_compact_get
      FLAGS+=(--agent-kwarg "mcp_env={\"HINDSIGHT_URL\":\"$SEM_URL\"}" --agent-kwarg stop_hook=true) ;;
  esac
  FLAGS+=(--mounts "$(printf '[%s,%s,%s,%s]' \
    "{\"type\":\"bind\",\"source\":\"$R_C\",\"target\":\"/repo\",\"read_only\":true}" \
    "{\"type\":\"bind\",\"source\":\"$REPO/node_modules\",\"target\":\"/repo/node_modules\",\"read_only\":true}" \
    "{\"type\":\"bind\",\"source\":\"$B/node\",\"target\":\"/opt/node\",\"read_only\":true}" \
    "{\"type\":\"bind\",\"source\":\"$STATE/$arm\",\"target\":\"/state\",\"read_only\":$ro}")")
  FLAGS+=(--agent-kwarg disallowed_tools="$deny")
}

# Run D arms. D_SHA is the only thing to change for a newer commit; then `./run_ctx.sh prep D`.
D_SHA=${D_SHA:-4dded1d}
R_D=$B/repo-D
# d-hybrid runs a newer commit from its own export (adaptive embedding batches); d-sqlite keeps $D_SHA in $R_D.
D_SHA_HYBRID=2ec584e
R_DH=$B/repo-Dh
# Run Dp: d-sqlite at $DP_SHA, run D's code plus the pointer that names the search tools as available.
DP_SHA=f1fd9f3
R_DP=$B/repo-Dp
d_sha() { case $RUN:$1 in Dp:*) echo "$DP_SHA";; *:d-hybrid) echo "$D_SHA_HYBRID";; *) echo "$D_SHA";; esac; }
d_repo() { case $RUN:$1 in Dp:*) echo "$R_DP";; *:d-hybrid) echo "$R_DH";; *) echo "$R_D";; esac; }
D_IMAGE=ghcr.io/berriai/litellm:v1.109.0-dev.1
D_EMB_MODEL=nomic-embed-text
D_EMB_PORT=18434
D_EMB_URL=http://$HOST_IP:$D_EMB_PORT/v1
D_ALLOW=mcp__openmem__smart_compact_search,mcp__openmem__smart_compact_get,mcp__openmem__smart_compact_sql

d_check() {  # refuse to run a D arm against an export of another commit
  local want have rd; rd=$(d_repo "$1")
  want=$(git -C "$REPO" rev-parse "$(d_sha "$1")^{commit}")
  have=$(cat "$rd/.bench-sha" 2>/dev/null || true)
  [ "$want" = "$have" ] || { echo "$rd is ${have:-missing}, $1 wants $want" >&2; exit 1; }
  [ -d "$rd/node_modules/yaml" ] || { echo "$rd/node_modules incomplete" >&2; exit 1; }
}
d_prep() {  # export the run's commit into its repo with its own production node_modules (never the main checkout's)
  local sha rd; sha=$(d_sha d-sqlite) rd=$(d_repo d-sqlite)
  rm -rf "$rd"; mkdir -p "$rd"
  git -C "$REPO" archive "$sha" | tar -x -C "$rd"
  (cd "$rd" && PATH="$B/node24/bin:$PATH" npm ci --omit=dev --no-audit --no-fund)
  git -C "$REPO" rev-parse "$sha^{commit}" > "$rd/.bench-sha"
  echo "$(basename "$rd") = $(cat "$rd/.bench-sha")"
}
# Ollama 0.40.1 (ollama/ollama:latest of 2026-10-08) on the Intel iGPU through Vulkan: ~3.6 s per 8000-char row vs
# ~14 s on CPU. 0.12.6 never returned for inputs over the model's 2048-token context.
D_OLLAMA_IMAGE=ollama/ollama@sha256:69f27594d8127cb43db1edcafa5e2d3cd8f88bdbc54a2cf3ceb11b8d138a24b1
d_ollama() {  # cbench-ollama: own volume, published on loopback and the docker0 gateway; never openmem's Ollama
  case $1 in
    up) docker inspect cbench-ollama >/dev/null 2>&1 || docker run -d --name cbench-ollama --label cbench=1 \
          --device /dev/dri -e OLLAMA_VULKAN=1 -e OLLAMA_IGPU_ENABLE=1 \
          -p "127.0.0.1:$D_EMB_PORT:11434" -p "$HOST_IP:$D_EMB_PORT:11434" -v cbench-ollama-data:/root/.ollama \
          "$D_OLLAMA_IMAGE" >/dev/null
        docker start cbench-ollama >/dev/null; sleep 2
        docker exec cbench-ollama ollama pull "$D_EMB_MODEL" >/dev/null 2>&1
        curl -fsS "$D_EMB_URL/embeddings" -H 'content-type: application/json' \
          -d "{\"model\":\"$D_EMB_MODEL\",\"input\":[\"ok\"]}" >/dev/null && echo "cbench-ollama ok at $D_EMB_URL" ;;
    down) docker rm -f cbench-ollama >/dev/null ;;
    *) echo "usage: $0 ollama up|down" >&2; exit 2 ;;
  esac
}

proxy_up_d() {  # as s3a-smart, D code and image; d-hybrid also embeds rows
  local arm=$1 p emb=(); p=$(port "$arm")
  [ "$arm" = d-hybrid ] && emb=(-e CONTEXT_EMBEDDING_MODEL="$D_EMB_MODEL" -e CONTEXT_EMBEDDING_URL="$D_EMB_URL")
  d_check "$arm"
  docker rm -f "$(pname "$arm")" >/dev/null 2>&1 || true
  mkdir -p -m 700 "$STATE/$arm/context"
  mkdir -p "$RESULTS/$arm"
  docker run -d --name "$(pname "$arm")" --label cbench=1 \
    -p "$HOST_IP:$p:4000" --user "$(id -u):$(id -g)" --env-file "$ENV_FILE" \
    -e HOME=/tmp -e PYTHONDONTWRITEBYTECODE=1 -e PYTHONPATH=/app/proxy \
    -e OPENMEM_STATE_DIR=/state -e HINDSIGHT_URL=http://127.0.0.1:9 \
    -e CONTEXT_PROXY_ENABLED=1 -e CONTEXT_TRIM_AT_TOKENS="$TRIM_AT" -e CONTEXT_COMPRESS_OVER_TOKENS="$COMPRESS_AT" \
    "${emb[@]}" -e BENCH_ARM="$arm" -e BENCH_USAGE_LOG=/results/usage.jsonl \
    -v "$(d_repo "$arm")/proxy:/app/proxy:ro" -v "$B/litellm:/app/bench:ro" \
    -v "$STATE/$arm:/state" -v "$RESULTS/$arm:/results" \
    "$D_IMAGE" --config /app/bench/bench-config.yaml --port 4000 --num_workers 1 >/dev/null
}

arm_flags_d() {  # strict base flags, then D's MCP (repo-D + Node 24), state read-only, the three smart_compact tools
  local arm=$1 deny=$DENY_BUILTIN$DENY_MCP
  d_check "$arm"
  arm_flags_strict "$arm"
  unset 'FLAGS[-1]' 'FLAGS[-1]'  # drop the trailing --agent-kwarg disallowed_tools=$DENY_BUILTIN pair
  FLAGS+=(--agent-kwarg openmem_mcp=true --agent-kwarg allowed_tools="$D_ALLOW")
  [ "$arm" = d-hybrid ] && FLAGS+=(--agent-kwarg \
    "mcp_env={\"CONTEXT_EMBEDDING_MODEL\":\"$D_EMB_MODEL\",\"CONTEXT_EMBEDDING_URL\":\"$D_EMB_URL\"}")
  FLAGS+=(--mounts "$(printf '[%s,%s,%s]' \
    "{\"type\":\"bind\",\"source\":\"$(d_repo "$arm")\",\"target\":\"/repo\",\"read_only\":true}" \
    "{\"type\":\"bind\",\"source\":\"$B/node24\",\"target\":\"/opt/node\",\"read_only\":true}" \
    "{\"type\":\"bind\",\"source\":\"$STATE/$arm\",\"target\":\"/state\",\"read_only\":true}")")
  FLAGS+=(--agent-kwarg disallowed_tools="$deny")
}

wait_live() {
  local arm i
  for arm in $ARMS; do
    for i in $(seq 60); do
      curl -fsS "http://$HOST_IP:$(port "$arm")/health/liveliness" >/dev/null 2>&1 && break
      [ "$i" = 60 ] && { docker logs --tail 40 "$(pname "$arm")" >&2; echo "$arm proxy not live" >&2; exit 1; }
      sleep 2
    done
    echo "$RUN $arm proxy live on $(port "$arm")"
  done
}

case "${1:-}" in
  prep) case ${2:-} in D|Dp) RUN=$2; d_prep ;; *) echo "usage: $0 prep D|Dp" >&2; exit 2 ;; esac ;;
  ollama) d_ollama "${2:-}" ;;
  up) setrun "$2"; load_token; for a in $ARMS; do proxy_up "$a"; done; wait_live ;;
  down) setrun "$2"; for a in $ARMS; do
          docker logs "$(pname "$a")" > "$RESULTS/$a/proxy.log" 2>&1 || true
          docker rm -f "$(pname "$a")" >/dev/null 2>&1 || true; done ;;
  one) setrun "$2"; load_token; arm=$3 task=$4 name=$5
       mkdir -p "$RESULTS/$arm/trials" "$B/ctx"
       echo "$(date -u +%FT%TZ) start $RUN $arm $task $name" >> "$B/ctx/started.txt"
       trial "$arm" "$task" "$RESULTS/$arm/trials" "$name" > "$RESULTS/$arm/$name.log" 2>&1
       echo "$RUN $arm $task $name" >> "$B/ctx/done.txt" ;;
  smoke) setrun "$2"; load_token; arm=$3 task=${4:-kv-store-R1000-seed42}
         mkdir -p "$RESULTS/$arm/trials"
         trial "$arm" "$task" "$RESULTS/$arm/trials" "$RUN-$arm.$task" > "$RESULTS/$arm/$RUN-$arm.$task.log" 2>&1 ;;
  summarize) setrun "$2"; "$B/.venv/bin/python" "$B/summarize.py" "$RESULTS" "$STATE" > "$RESULTS/summary-base.md" ;;
  *) echo "usage: $0 prep|ollama|up|down|one|smoke|summarize ..." >&2; exit 2 ;;
esac
