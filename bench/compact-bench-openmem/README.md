# Compact-Bench Task Preservation with Claude Code and OpenMem

Adapter for the Task Preservation track of [compact-bench](https://github.com/cai-jianfeng/compact-bench)
(clone in `../compact-bench`, commit 9dd9a3f, unmodified). It replaces the harness's two model calls
and adds an `openmem` compaction method. Everything else is the harness's code: instance setup,
the frozen phase-A history and snapshot, snapshot restore, `force_state`, the FAIL_TO_PASS judge,
and the scorer (`scripts/score_e1.aggregate`).

| Step | Harness | This adapter |
|---|---|---|
| Continuation agent (PRE and every POST) | `e1_runner.episode`: Messages tool loop, 8 steps, `max_tokens` 4096, tools `read_file`, `run_command` | `claude -p --resume <sid>`, Haiku 5.5, `--max-turns 8`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS=4096`, the same two tools served by `cb_tools_mcp.py` (calls `e1_runner.read_file` / `run_cmd`), `--tools ""` and `--strict-mcp-config` |
| Summarizer (`claude`, `codex`, … prompts) | `cb_common.summarize` on `build_transcript(H) + PROMPTS[p]`, 16384 output tokens | `claude -p`, Haiku 5.5, one turn, no tools, same input and output cap |
| `openmem` | none | `openmem_view.compact`: every message into `sessions/<sid>.db` with the proxy's store code, the proxy's trimmed view as the resumed history, OpenMem's MCP server limited to `smart_compact_search/get/sql`, the proxy's standing instruction appended to the system prompt |

## Run

```bash
./run.sh --instance pylint-dev__pylint-6903 --methods claude,openmem --rounds 1 --output results/smoke
# all 33 scored tasks, 2 at a time, venvs and repo copies deleted after each task, stop below 4 GB free
python3 drive.py --output results/full --methods claude,codex,openmem,openmem-proxy
```

`openmem` uses `--openmem-budget` (default `match:claude`); `openmem-proxy` always uses budget 0.
The two instances the scorer excludes are skipped unless `--include-excluded`. A model call that ends
without a result event, with an API error, or with a rate/usage-limit message is retried after a
wait (`cc_continue.limit_wait`: exponential up to 30 min, or until a reported usage-limit reset), up
to 12 attempts, from a freshly restored snapshot; `error_max_turns` is a normal outcome and is judged.
`drive.py` prints one `TASK` line per instance (pass/fail per round, smart_compact calls, list cost)
and the scorer table at the end.

`run.sh` loads the OAuth token from `../state/oauth-token` into `CLAUDE_CODE_OAUTH_TOKEN`, uses
Python 3.9 for the task venvs (`CB_PYTHON`, installed with `UV_PYTHON_INSTALL_DIR=../uvpy uv python install 3.9`),
Node 24 (`../node24`) for OpenMem's MCP server, and the OpenMem export named by `OPENMEM_SHA` /
`OPENMEM_REPO` (default `cbe332a`, `../repo-main`, a `git archive` export plus `npm ci --omit=dev`). Point those two variables at a newer export to
rerun; nothing else depends on the commit. PRE runs once per instance; methods and rounds resume from
existing result files. Results: `<output>/<iid>__baseline.json` (PRE),
`<output>/<iid>__xb-<method>.cbo[.r2|.r3].json` (POST), `task_report.md` (the harness's table, one row
per method). Work files (stream-json, session files, OpenMem DBs, venvs) are under `work/`.

## Design

**Resumed history.** `cc_continue.write_session` writes the history as a Claude Code session file
(`$CLAUDE_CONFIG_DIR/projects/<cwd slug>/<sid>.jsonl`, one user/assistant entry per message) and
`--resume` loads it. That format is internal to Claude Code; it was checked with 2.1.280 by
resuming a synthetic history and asking for a value only present in an earlier tool result. The
continuation message goes in through `--input-format stream-json`, so the openmem pointer stays a
separate text block as the proxy renders it. History tool names are mapped to their MCP names
(`read_file` → `mcp__cb__read_file`) for every method. Each call has its own `CLAUDE_CONFIG_DIR`,
so the user's hooks, plugins and CLAUDE.md do not apply.

**PRE / summary POST.** PRE resumes the full frozen history H. A summary method resumes one user
message, `"The conversation so far has been compacted. What follows is the summary:\n\n" + S`,
exactly as `e1_xb`. All arms then get the harness's continuation message.

**openmem POST.** The request at the compaction point is `H + [continuation]`. Every message of it
is written to `<work>/openmem.rN/openmem-state/context/sessions/<sid>.db` by `core.stored_rows` and
`sessiondb.SessionDB.sync`, the proxy's writer; dropped rows get `in_context = 0`. The view is
`core.render` of `core.choose_cut`'s cut with `core.pointer_text(sid, dropped)`:

- `--openmem-budget 0` is the proxy's rule unchanged. The cut is the last real user turn. Phase A is
  one user turn followed by tool loops, so the view is the first user turn (task statement) plus
  pointer + continuation: no phase-A step survives.
- `--openmem-budget N` also keeps the most recent phase-A steps whose text fits N tokens. It reuses
  `choose_cut` with a one-method adapter subclass (`StepAdapter`: the only turn start is one
  candidate assistant message, so `choose_cut` returns it iff the proxy's call/result pairing check
  accepts it) and `render`. The pointer then lands on an assistant message; the proxy only ever
  prepends it to a user turn.
- Default `match:claude`: N is the size of the `claude`-prompt summary for the same instance and
  round, in `tokens.text_tokens` units (characters / 4), so openmem keeps about as many history
  tokens as the summary method passes on, plus the pinned task statement (which the summary methods
  drop) and the pointer. The harness sizes the summary only by its output cap (16384 tokens) and the
  transcript by its 250,000-character tail cap, so the summary's actual length is the only per-task
  measure of what a summary method keeps.

**Cost.** Claude Code 2.1.280 does not know Haiku 5.5's price (`modelUsage.costBasis: "unknown"`) and
reports a `total_cost_usd` about 30 times the list price. `cost_usd` in the records is recomputed
from the result event's `usage` at list price (`cc_continue.PRICE`); `cc_reported_cost_usd` keeps
Claude Code's number. Subscription runs are not billed per token; the figure sizes the usage.

## Deviations from the harness

- The agent runs under Claude Code's system prompt (about 9k tokens) for every method.
- Haiku 5.5 still produced thinking tokens with `MAX_THINKING_TOKENS=0`; the harness sends no thinking parameter.
- `--max-turns 8` counts Claude Code turns; for openmem, smart_compact calls use turns the other methods spend on the repair.
- The summarizer runs under `--system-prompt "You are a helpful assistant."`; the harness sends no system prompt.
