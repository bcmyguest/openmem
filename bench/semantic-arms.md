# Strict-bench arms s3c and s3d: semantic search of trimmed turns

Two new arms for `run_strict.sh`-style trials. Both trim like `s3a-smart` (proxy trim at `$TRIM_AT`, compression over
`$COMPRESS_AT`, `DISABLE_AUTO_COMPACT=1`). They differ only in how the agent gets trimmed content back.

| Arm | Design | Content reaches the provider | Agent's lookup tool | Session scope |
| --- | --- | --- | --- | --- |
| `s3c-semantic` | (a) ingest at trim time | MCP server copies `sessions/<sid>.log.jsonl` rows (every 2 s, and before each semantic search) | `smart_compact_search(mode: "semantic")` (+ lexical, `smart_compact_get`) | tag `openmem-session:<sid>`, enforced client-side |
| `s3d-recall` | (b) existing path | Stop hook retains the new transcript text at the end of every `claude -p` | `memory_recall` only | none: one bank per trial |

Code under test: commit `eb1e574` on branch `worktree-agent-af81ab3288ab14e4a` (parent `788010a`). It is NOT in
`$REPO` (`/home/brandonguest/personal-memory`, the checkout the running bench mounts). Nothing below changes `$REPO`,
`run_strict.sh`, `cc_stream.py` or the `openmem` / `personal-memory` compose projects; the patches in section 4 are
proposals for the bench owner to apply when the current run has finished.

## 1. Provider: Hindsight + Ollama `gemma4:e2b`, compose project `cbench-mem`

Choice: the repository's own pinned Hindsight image, its `litellm` service, and a private `ollama` service, all under
`docker compose -p cbench-mem`. Embeddings and reranker are Hindsight's local models; retain runs in `verbatim` mode
(chunk text stored as is, the LLM only tags entities and times). No API spend.

Why this one:

- It is the only provider the repo ships as a compose service. mem0's fragment is URL-only (no server image), and
  Cognee needs `cognify` plus an LLM before new rows are searchable.
- Hindsight reports per-operation ingest status, so the `pending` / bounded-wait path of design (a) gets exercised;
  mem0 ingest is synchronous and Cognee reports none.
- Design (b) already depends on Hindsight in practice: the Stop hook's async retention is Hindsight-shaped.

Cost: CPU only. `openmem-ollama-1` has no GPU device request on this host, so `cbench-mem`'s Ollama will not either.
Expect extraction lag of seconds per batch; s3c then shows `pending: true` until it drains. That is a property of the
arm, not a failure, but report it alongside scores.

The host Ollama on 127.0.0.1:11434 belongs to the `openmem` project; do not use or attach to it. `cbench-mem` runs
its own Ollama with no published port.

### Files (all under `$B/mem/`)

```sh
B=/tmp/claude-1001/-home-brandonguest-personal-memory/e0022e09-ad3b-4956-9e79-f47387c967e6/scratchpad/bench
M=$B/mem; mkdir -p -m 700 $M
KEY="sk-cbench-$(openssl rand -hex 12)"

printf 'LITELLM_MASTER_KEY=%s\n' "$KEY" > $M/litellm.env

# Hindsight settings: config/hindsight.env.example with the bench key and worker id.
cat > $M/hindsight.env <<EOF
HINDSIGHT_API_LLM_PROVIDER=openai
HINDSIGHT_API_LLM_BASE_URL=http://litellm:4000/v1
HINDSIGHT_API_LLM_MODEL=memory-reflect
HINDSIGHT_API_RETAIN_LLM_MODEL=memory-retain
HINDSIGHT_API_REFLECT_LLM_MODEL=memory-reflect
HINDSIGHT_API_CONSOLIDATION_LLM_MODEL=memory-consolidate
HINDSIGHT_API_MENTAL_MODEL_REFRESH_LLM_MODEL=memory-reflect
HINDSIGHT_API_LLM_API_KEY=$KEY
HINDSIGHT_API_EMBEDDINGS_PROVIDER=local
HINDSIGHT_API_RERANKER_PROVIDER=local
HINDSIGHT_API_WORKER_ID=cbench-mem
HINDSIGHT_API_SKIP_LLM_VERIFICATION=true
HINDSIGHT_API_LLM_MAX_CONCURRENT=2
HINDSIGHT_API_LLM_TIMEOUT=300
HINDSIGHT_API_LLM_MAX_RETRIES=1
HINDSIGHT_API_RETAIN_EXTRACTION_MODE=verbatim
HINDSIGHT_API_RETAIN_MAX_COMPLETION_TOKENS=16384
HINDSIGHT_API_REFLECT_MAX_COMPLETION_TOKENS=2048
HINDSIGHT_API_CONSOLIDATION_MAX_COMPLETION_TOKENS=2048
EOF

# LiteLLM routes: config/litellm.ollama.yaml, every alias on gemma4:e2b at the project's own ollama service.
cat > $M/litellm.yaml <<'EOF'
model_list:
  - model_name: memory-retain
    litellm_params: {model: ollama_chat/gemma4:e2b, api_base: "http://ollama:11434", max_tokens: 4096, timeout: 300, extra_body: {think: false}}
  - model_name: memory-reflect
    litellm_params: {model: ollama_chat/gemma4:e2b, api_base: "http://ollama:11434", max_tokens: 4096, timeout: 300, extra_body: {think: false}}
  - model_name: memory-consolidate
    litellm_params: {model: ollama_chat/gemma4:e2b, api_base: "http://ollama:11434", max_tokens: 4096, timeout: 300, extra_body: {think: false}}
general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
EOF

# Replaces the repo's .env, so the stack's real settings (ports 8888/9999, profiles) never apply.
cat > $M/compose.env <<EOF
HOST_UID=$(id -u)
HOST_GID=$(id -g)
LITELLM_CONFIG=$M/litellm.yaml
LITELLM_ENV_FILE=$M/litellm.env
HINDSIGHT_ENV_FILE=$M/hindsight.env
CONTEXT_PROXY_ENV_FILE=$M/litellm.env
HINDSIGHT_PORT=18988
HINDSIGHT_CP_PORT=18999
EOF

# Ports: Hindsight on loopback and on the docker0 gateway (Harbor sandboxes use 172.17.0.1); Ollama unpublished,
# so it cannot collide with openmem-ollama-1 on 127.0.0.1:11434.
cat > $M/cbench-mem.yaml <<'EOF'
services:
  hindsight:
    ports: !override
      - "127.0.0.1:18988:8888"
      - "172.17.0.1:18988:8888"
  ollama:
    ports: !override []
EOF
```

### Code checkout for the arms

```sh
WT=/home/brandonguest/personal-memory/.claude/worktrees/agent-af81ab3288ab14e4a
R=$B/repo-semantic; mkdir -p $R
git -C $WT archive eb1e574 | tar -x -C $R
mkdir -p $R/node_modules   # mount point; the dependencies come from $REPO/node_modules (see arm_flags below)
```

### Up, model, health, teardown

```sh
DC="docker compose -p cbench-mem --env-file $M/compose.env -f $R/compose.yaml -f $M/cbench-mem.yaml --profile hindsight --profile ollama"
$DC config --services                  # must list only services of this file; fails fast on a missing variable
$DC up -d ollama hindsight             # name the services: a bare `up` would also start the indexer
$DC exec ollama ollama pull gemma4:e2b # once per cbench-mem_ollama-data volume, about 4.6 GB
curl -fsS http://127.0.0.1:18988/health && curl -fsS http://172.17.0.1:18988/health

# Between runs: drop the banks the arms wrote.
curl -fsS -X DELETE http://127.0.0.1:18988/v1/default/banks/openmem-context
# After the bench: everything, including volumes, of this project only.
$DC down -v
```

Always pass `-p cbench-mem`: `compose.yaml` says `name: openmem`, and only `-p` keeps compose off that project.

## 2. Arm s3c-semantic (design a)

- **Proxy:** `proxy_up` exactly as `s3a-smart` (`CONTEXT_PROXY_ENABLED=1`, compression on). The proxy needs nothing
  new: design (a) never calls the provider from the proxy.
- **MCP env:** add `CONTEXT_SEMANTIC_INGEST=1`, `HINDSIGHT_URL=http://172.17.0.1:18988`, and optionally
  `CONTEXT_SEMANTIC_WAIT_S` (default 10). Bank: `openmem-context`, shared by concurrent trials; rows are tagged per
  session and every hit is checked against the session id, so trials cannot read each other's rows.
- **State mount must be read-write.** The MCP server writes `sessions/<sid>.ingest.json` and `.ingest.lock` next to
  the logs. `run_strict.sh` mounts `$STATE/$arm` read-only; with a read-only mount the sync throws (EROFS) and every
  semantic search returns an error. Files the container writes there are owned by the sandbox user (likely root).
- **Tools:** same allow/deny as s3a: only `mcp__openmem__smart_compact_search` and `_get`. With ingest on, the tool
  schema gains `mode: "lexical" | "semantic"` and the description says when to use it. The agent picks the mode;
  the standing instruction and pointer still advertise `query` / `pattern` only. To measure the semantic path rather
  than the agent's choice, also run a variant whose STRICT note adds one line: "Prefer
  smart_compact_search mode "semantic" for questions about earlier content." Count `mode` values in tool inputs.
- **Freshness:** each `claude -p` starts a new MCP process; it syncs logs written in the last 15 minutes every 2 s
  while the turn runs, and a semantic search syncs its session first, so rows trimmed in any earlier turn are covered.

## 3. Arm s3d-recall (design b)

Nothing new in the repo. At runtime (b) needs all of this, none of which the current strict arms have:

1. **A Stop hook inside the sandbox.** Strict trials run `claude -p` with a fresh `CLAUDE_CONFIG_DIR` and no hooks, so
   nothing is ever retained. Pass settings with `--settings`:
   ```json
   {"hooks": {"Stop": [{"hooks": [{"type": "command", "timeout": 60,
     "command": "HOME=/tmp/cb_cc/mcp-home HINDSIGHT_URL=http://172.17.0.1:18988 /opt/node/bin/node /repo/cli/coding-agent/hook-runner.mjs claude-code stop"}]}]}}
   ```
   Only Stop. A SessionStart hook would inject recall at every `--resume` and a UserPromptSubmit hook on every prompt,
   which is a different design (automatic recall), not "the agent calls memory_recall".
2. **A provider reachable from the sandbox:** `http://172.17.0.1:18988` for both the hook process and the MCP server
   (`HINDSIGHT_URL` in the MCP env; cc_stream currently pins `http://127.0.0.1:9`).
3. **A writable, persistent HOME for the hook:** it keeps its transcript cursor in
   `$HOME/.config/personal-memory/transcript-cursors.json` and reads `$HOME/.config/personal-memory/coding-agent.json`.
   `/tmp/cb_cc/mcp-home` lives as long as the trial container, across turns.
4. **One bank per trial.** Retention has no session scope: the hook writes to the bank mapped from cwd `/app`, and
   concurrent trials with different seeds would recall each other's values from a shared bank. Write
   `coding-agent.json` = `{"mapPathToBank": {"/app": "cbench-s3d-<first 8 of cc_session_id>"}}` and tell the agent the
   bank in the STRICT note: "Turns removed from your context are stored in memory bank "<bank>"; call
   memory_recall(query=..., bank="<bank>") before answering anything you cannot see." (`memory_recall` defaults to
   bank `openmem-mcp` otherwise.)
5. **Tools:** allow `mcp__openmem__memory_recall`; disallow every other openmem tool, including
   `smart_compact_search` and `smart_compact_get`. Set `CONTEXT_STANDING_INSTRUCTION=0` on the s3d proxy, since the
   standing instruction names `smart_compact_search`. The trim pointer still names it; that text is fixed in the
   proxy, so expect some calls to the disallowed tool and count them.
6. **Know what retention keeps** (`cli/coding-agent/hook-runner.mjs`): per Stop, the new part of the transcript,
   at most the last 256 KB read, reduced to user/assistant text and `[action: <tool> <input>]` lines; tool results
   and thinking are dropped; the result is cut to its last 12000 characters, so a long op loses its head. Retention is
   async (Hindsight `async: true`): content from turn N is searchable only after turn N's Stop hook and extraction,
   and `memory_recall` gives no `pending` signal. Retention fails silently when Hindsight is unreachable (the hook
   exits 1, Claude Code continues).

## 4. Proposed bench patches (not applied)

`cc_stream.py`, two kwargs, default off, so existing arms are unchanged:

```python
# __init__(..., mcp_env: str = "", stop_hook: bool = False, ...)
self.mcp_env = json.loads(mcp_env) if mcp_env else {}   # e.g. '{"CONTEXT_SEMANTIC_INGEST":"1","HINDSIGHT_URL":"http://172.17.0.1:18988"}'
self.stop_hook = str(stop_hook).strip().lower() in TRUE

# mcp_config(): merge after the defaults so HINDSIGHT_URL can be overridden
"env": {"OPENMEM_STATE_DIR": ..., "HOME": ..., "HINDSIGHT_URL": "http://127.0.0.1:9", **self.mcp_env},

# run(), after mcp.json is written:
if self.stop_hook:
    bank = f"cbench-s3d-{self.cc_session_id[:8]}"
    url = self.mcp_env.get("HINDSIGHT_URL", "http://127.0.0.1:9")
    hook = (f"HOME={WORK}/mcp-home HINDSIGHT_URL={url} {self.mcp_node} "
            f"{self.mcp_repo}/cli/coding-agent/hook-runner.mjs claude-code stop")
    settings = {"hooks": {"Stop": [{"hooks": [{"type": "command", "command": hook, "timeout": 60}]}]}}
    await environment.exec(f"mkdir -p {WORK}/mcp-home/.config/personal-memory", timeout_sec=60)
    await self._cb_put_text(environment, json.dumps({"mapPathToBank": {"/app": bank}}),
                            f"{WORK}/mcp-home/.config/personal-memory/coding-agent.json")
    await self._cb_put_text(environment, json.dumps(settings), f"{WORK}/settings.json")
    instruction += f'\nTurns removed from your context are stored in memory bank "{bank}"; call memory_recall(query=..., bank="{bank}") before answering anything you cannot see.\n'

# _command(): if self.stop_hook: flags += f" --settings {WORK}/settings.json"
```

`run_strict.sh` (or a copy, as `run_ctx.sh` does):

```sh
SEM_URL=http://$HOST_IP:18988
R=$B/repo-semantic
port():      s3c-semantic) echo 4205;;  s3d-recall) echo 4206;;
proxy_up():  case $arm in s3c-semantic) en=1; comp=$COMPRESS_AT;; s3d-recall) en=1; comp=$COMPRESS_AT;; esac
             # s3d only: add  -e CONTEXT_STANDING_INSTRUCTION=0  to the docker run
arm_flags(): s3c-semantic|s3d-recall) mount $R (not $REPO) at /repo, $REPO/node_modules at /repo/node_modules (ro),
             $B/node at /opt/node (ro), and $STATE/$arm at /state — read_only false for s3c, true is fine for s3d
  s3c-semantic: deny+=$DENY_MCP
                --agent-kwarg mcp_env="{\"CONTEXT_SEMANTIC_INGEST\":\"1\",\"HINDSIGHT_URL\":\"$SEM_URL\"}"
  s3d-recall:   deny+=${DENY_MCP/,mcp__openmem__memory_recall/},mcp__openmem__smart_compact_search,mcp__openmem__smart_compact_get
                --agent-kwarg mcp_env="{\"HINDSIGHT_URL\":\"$SEM_URL\"}" --agent-kwarg stop_hook=true
```

## 5. Checks before trusting a run

- Smoke one trial per arm (`SMOKE_STEPS` large enough to force a trim at `$TRIM_AT`).
- s3c: `ls $STATE/s3c-semantic/context/sessions/*.ingest.json` exists after the first trim, its `seq` reaches the
  log's last `seq`, and `curl -s "http://127.0.0.1:18988/v1/default/banks/openmem-context/memories/list?limit=1"`
  is non-empty. Tool results with `"mode": "semantic"` carry `score`; count `pending: true` results.
- s3d: after the first turn, `memories/list` on bank `cbench-s3d-<id>` is non-empty; no retention means the Stop
  hook did not run (check `/logs/agent/cc-turn-*.jsonl` for hook errors).
- Both: `docker logs cbench-mem-hindsight-1` shows no LLM errors, and `operations?status=failed` stays 0.

## 6. Unverified

- No trial has been run with either arm; nothing above was executed against a real Hindsight. The facade's
  Hindsight `tags` / `tags_match: "all_strict"`, `metadata` and `document_id` fields match the OpenAPI of the
  running Hindsight 1.0.0 (`/openapi.json`), but whether recall results echo `metadata` / `document_id` back in
  verbatim mode is untested; the code falls back from one to the other and drops hits it cannot map.
- `ollama pull gemma4:e2b`: the `openmem` stack's model of that name is a local build; the public tag may differ.
- Extraction speed on CPU and whether 10 s covers typical trims.
- `--settings` hooks firing under `claude -p --tools "" --strict-mcp-config` (expected, not observed here).
