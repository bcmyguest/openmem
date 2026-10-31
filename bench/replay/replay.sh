#!/usr/bin/env bash
# Replay benchmark: two real coding tasks (briefs/) replayed by Claude Code on Haiku 4.5 under run E's
# e-smart and e-native arms, to see whether smart trimming makes the agent circle (re-read files, repeat calls).
#
#   ./replay.sh up | down              start / remove the two bench proxies (ports 4270, 4271)
#   ./replay.sh trial ARM TASK SEED [MAX_TURNS]   one trial; TASK = decision-fixes | step2c
#   ./replay.sh queue [MAX]            run every line of queue.txt ("ARM TASK SEED"), MAX at a time (default 4)
#   ./replay.sh report                 metrics table (metrics.py) -> results/report.md
#
# Arms reuse run_ctx.sh's run E functions unchanged (proxy_up_d / proxy_up_e, repo-E proxy code at E_SHA,
# image D_IMAGE, proxy per-model trim threshold: Haiku 95k, tool-result compression over 4000 tokens):
#   e-smart   proxy trim + compression, DISABLE_AUTO_COMPACT=1, OpenMem MCP (smart_compact_* only)
#   e-native  proxy pass-through, Claude Code's default auto-compaction
# Difference from run E: the agent runs on the host (claude -p, built-in tools, cwd = a fresh per-trial worktree
# under work/) instead of Harbor/Docker strict mode, because these tasks need a shell and files. Confinement:
# permission mode dontAsk (only the listed tools; Edit/Write only inside the worktree), Bash in Claude Code's
# bubblewrap sandbox (writes: worktree, per-trial TMPDIR, the worktree's git metadata; no network; no
# unsandboxed retry).
set -euo pipefail
R=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
B=$(dirname "$R")
M=$(dirname "$B")
source <(sed -n '/^REPO=/,/^pname()/p' "$B/run_strict.sh")
source <(sed -n '/^load_token()/,/^}/p;/^arm_headers()/,/^}/p' "$B/run_strict.sh")
source <(sed -n '/^E_SHA=/,/^D_ALLOW=/p;/^d_check()/,/^}/p;/^proxy_up_d()/,/^}/p;/^proxy_up_e()/,/^}/p' "$B/run_ctx.sh")

RUN=E                      # d_sha / d_repo: run E's commit and export
MODEL=claude-haiku-4-5-20251001
TRIM_AT=                   # the proxy's per-model threshold, as run E
RESULTS=$R/results
STATE=$R/state
ARMS="e-smart e-native"
TRIAL_TIMEOUT=${TRIAL_TIMEOUT:-4500}   # seconds of agent wall time
TRIAL_USD_CAP=${TRIAL_USD_CAP:-3.00}   # watchdog: stop a trial whose list-price spend passes this
PY=$B/.venv/bin/python
NODE=$(command -v node)
CLAUDE=$(command -v claude)
TOOLS=Bash,Read,Glob,Grep,LS,TodoWrite,BashOutput,KillShell
# later history the agent must not see: the main checkout's bench/cb (holds dea0ee6, the decision-fixes result) and
# the original task worktrees
HIDE="$M/bench/cb $M/.claude/worktrees"

port() { case $1 in e-smart) echo 4270;; e-native) echo 4271;; *) echo "unknown arm $1" >&2; exit 2;; esac; }
pname() { echo "cbench-replay-$1"; }
proxy_up() { case $1 in e-smart) proxy_up_d "$1";; e-native) proxy_up_e "$1";; esac; }

wait_live() {
  local arm i
  for arm in $ARMS; do
    for i in $(seq 60); do
      curl -fsS "http://$HOST_IP:$(port "$arm")/health/liveliness" >/dev/null 2>&1 && break
      [ "$i" = 60 ] && { docker logs --tail 40 "$(pname "$arm")" >&2; echo "$arm proxy not live" >&2; exit 1; }
      sleep 2
    done
    echo "replay $arm proxy live on $(port "$arm")"
  done
}

# ------------------------------------------------------------------ per-trial checkouts
prep_decision-fixes() {  # outer worktree at 370be19, nested bench/cb repo at 574a275 (no later history), 6 task dirs
  local w=$1
  git -C "$M" worktree add -q --detach "$w" 370be19
  git clone -q --no-local "$B/cb" "$w/bench/cb"
  ( cd "$w/bench/cb" && git checkout -q -B master 574a275 && git remote remove origin \
      && { git for-each-ref --format='%(refname)' | grep -v '^refs/heads/master$' || true; } | xargs -r -n1 git update-ref -d \
      && git reflog expire --expire=now --all && git gc -q --prune=now )
  cp -a "$R"/inputs/decision-tasks/decision-ledger-D* "$w/bench/cb/tasks/"
}
prep_step2c() {  # outer worktree at 0809dc3 with the main checkout's node_modules copied in (same package.json)
  local w=$1
  git -C "$M" worktree add -q --detach "$w" 0809dc3
  cp -a "$M/node_modules" "$w/"
  cp -a "$M/wizard/node_modules" "$w/wizard/"
}

brief_decision-fixes() {
  sed -e "s#/home/brandonguest/personal-memory/.claude/worktrees/decision-ledger-task#$1#g" \
      -e 's#(outer repo branch decision-ledger-task at 370be19)#(outer repo: detached HEAD at 370be19, standing in for branch decision-ledger-task; do not create or switch branches)#' \
      -e 's#(decision-ledger-task branch)#(your worktree, detached HEAD)#' \
      "$R/briefs/decision-fixes.md"
}
brief_step2c() {
  sed -e "s#/home/brandonguest/personal-memory/.claude/worktrees/scratchpad-phase2#$1#g" \
      -e 's#(branch scratchpad-phase2, HEAD 0809dc3,#(detached HEAD at 0809dc3, standing in for branch scratchpad-phase2,#' \
      -e 's#Commit on scratchpad-phase2#Commit on your worktree (detached HEAD; do not create or switch branches)#' \
      "$R/briefs/step2c.md"
}

tests_decision-fixes() { (cd "$1/bench/cb" && timeout 1200 "$B/.venv/bin/pytest" -q -p no:cacheprovider 2>&1) ; }
tests_step2c() {
  local rc=0
  (cd "$1" && timeout 600 npm test 2>&1) || rc=$?
  echo "=== npm test exit $rc"
  (cd "$1/proxy" && timeout 600 "$B/.venv/bin/pytest" -q -p no:cacheprovider 2>&1) || return 1
  return $rc
}

settings_json() {  # $1 worktree, $2 trial TMPDIR: Bash sandbox, writes only to the worktree and its git metadata
  local gd; gd=$(git -C "$1" rev-parse --absolute-git-dir)
  printf '{"sandbox":{"enabled":true,"failIfUnavailable":true,"autoAllowBashIfSandboxed":true,"allowUnsandboxedCommands":false,'
  printf '"filesystem":{"allowWrite":["%s","%s/objects","%s"],"denyRead":[%s]},' "$gd" \
    "$(git -C "$1" rev-parse --path-format=absolute --git-common-dir)" "$2" "$(printf '"%s",' $HIDE | sed 's/,$//')"
  printf '"network":{"allowedDomains":[],"strictAllowlist":true}}}\n'
}

trial() {  # $1 arm, $2 task, $3 seed, [$4 max turns]
  local arm=$1 task=$2 seed=$3 maxt=${4:-} name w t tmp sid deny allow rc trc t0 t1 extra=()
  name=$task.$arm.s$seed${maxt:+.smoke}
  w=$R/work/$name t=$RESULTS/$arm/trials/$name
  [ -e "$w" ] && { echo "$w exists" >&2; return 1; }
  mkdir -p "$t/agent" "$t/cc-config" "$t/mcp-home"
  # short TMPDIR: the sandbox binds Unix sockets there, and sun_path caps them at 108 bytes
  tmp=$(mktemp -d /tmp/rp-XXXXXX); ln -s "$tmp" "$t/tmp"
  "prep_$task" "$w"
  "brief_$task" "$w" > "$t/brief.md"
  settings_json "$w" "$tmp" > "$t/settings.json"
  sid=$(uuidgen)
  deny=EnterWorktree,ExitWorktree,WebFetch,WebSearch,Task,Agent
  for h in $HIDE; do deny+=",Read(/$h/**),Grep(/$h/**),Glob(/$h/**)"; done
  allow="$TOOLS,Edit(/$w/**),Write(/$w/**),MultiEdit(/$w/**),NotebookEdit(/$w/**)"
  if [ "$arm" = e-smart ]; then
    deny+=$DENY_MCP allow+=,$D_ALLOW
    extra+=(DISABLE_AUTO_COMPACT=1)
    printf '{"mcpServers":{"openmem":{"type":"stdio","command":"%s","args":["%s/cli/openmem-mcp.mjs"],"env":{"OPENMEM_STATE_DIR":"%s","HOME":"%s","HINDSIGHT_URL":"http://127.0.0.1:9"}}}}\n' \
      "$NODE" "$(d_repo e-smart)" "$STATE/e-smart" "$t/mcp-home" > "$t/mcp.json"
  else
    echo '{"mcpServers":{}}' > "$t/mcp.json"
  fi
  printf '{"arm":"%s","task":"%s","seed":%s,"name":"%s","session":"%s","workdir":"%s","model":"%s","max_turns":"%s"}\n' \
    "$arm" "$task" "$seed" "$name" "$sid" "$w" "$MODEL" "$maxt" > "$t/meta.json"
  t0=$(date +%s.%N)
  ( cd "$w" && exec env -i HOME="$HOME" USER="$USER" PATH="$PATH" LANG="${LANG:-C.UTF-8}" TERM=dumb \
      TMPDIR="$tmp" npm_config_cache="$tmp/npm" \
      CLAUDE_CONFIG_DIR="$t/cc-config" CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" \
      ANTHROPIC_BASE_URL="http://$HOST_IP:$(port "$arm")" ANTHROPIC_CUSTOM_HEADERS="$(arm_headers "$arm")" \
      ENABLE_TOOL_SEARCH=false CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 "${extra[@]}" \
      timeout "$TRIAL_TIMEOUT" "$CLAUDE" -p --verbose --output-format stream-json --model "$MODEL" \
        --session-id "$sid" --permission-mode dontAsk --settings "$t/settings.json" \
        --allowedTools "$allow" --disallowedTools "$deny" \
        --strict-mcp-config --mcp-config "$t/mcp.json" ${maxt:+--max-turns "$maxt"} -- "$(cat "$t/brief.md")" \
      > "$t/agent/cc-turn-0.jsonl" 2> "$t/agent/stderr.log" ) &
  local pid=$!
  while kill -0 "$pid" 2>/dev/null; do  # watchdog: list-price spend of this session from the proxy's usage rows
    sleep 30
    if "$PY" "$R/metrics.py" over "$RESULTS/$arm/usage.jsonl" "$sid" "$TRIAL_USD_CAP"; then
      echo "usd cap $TRIAL_USD_CAP hit" > "$t/agent/watchdog.txt"
      pkill -TERM -f -- "--session-id $sid" 2>/dev/null || true
    fi
  done
  rc=0; wait "$pid" || rc=$?
  t1=$(date +%s.%N)
  trc=0; "tests_$task" "$w" > "$t/tests.log" 2>&1 || trc=$?
  printf '{"agent_rc":%s,"tests_rc":%s,"wall_s":%s}\n' "$rc" "$trc" "$(echo "$t1 - $t0" | bc)" > "$t/run.json"
  "$PY" "$R/metrics.py" trial "$t" "$RESULTS/$arm/usage.jsonl" > "$t/trial.json"
  echo "$name done: agent rc $rc, tests rc $trc"
}

queue() {  # queue.txt lines "ARM TASK SEED", at most $1 concurrent (ctx_sched.py's default MAX 4)
  local max=${1:-4} arm task seed
  while read -r arm task seed; do
    [ -z "$arm" ] || [ "${arm:0:1}" = "#" ] && continue
    while [ "$(jobs -rp | wc -l)" -ge "$max" ]; do sleep 10; done
    trial "$arm" "$task" "$seed" > "$RESULTS/$arm/$task.$arm.s$seed.log" 2>&1 &
    sleep 5
  done < "$R/queue.txt"
  wait
}

clean() {  # remove one trial's worktree and results ($1 = trial name, e.g. decision-fixes.e-smart.s1.smoke)
  git -C "$M" worktree remove --force "$R/work/$1" 2>/dev/null || rm -rf "$R/work/$1"
  git -C "$M" worktree prune
  rm -rf "$RESULTS"/*/trials/"$1"
}

case "${1:-}" in
  clean) clean "$2" ;;
  up) load_token; for a in $ARMS; do proxy_up "$a"; done; wait_live ;;
  down) for a in $ARMS; do docker logs "$(pname "$a")" > "$RESULTS/$a/proxy.log" 2>&1 || true
          docker rm -f "$(pname "$a")" >/dev/null 2>&1 || true; done ;;
  trial) load_token; shift; trial "$@" ;;
  queue) load_token; queue "${2:-4}" ;;
  report) "$PY" "$R/metrics.py" report "$RESULTS" | tee "$RESULTS/report.md" ;;
  *) echo "usage: $0 up|down|trial|queue|report" >&2; exit 2 ;;
esac
