# Evidence plan: smart compaction, run E

Pre-registered experiment programme for the claim in [context-management.md](context-management.md#benchmarks): *OpenMem smart compaction keeps ContextBench scores at or above keep-everything while costing less than native compaction and keep-everything.* Nothing here has run. Budget: **$58 at list price** (phases 1–5), hard stop at $75.

## 0. What the published numbers rest on

| Run | What | n | Where |
| --- | --- | --- | --- |
| Strict | 4 arms, kv R4000 + log L6400, seeds 42–44 | 24 | context-research.md §Strict run |
| B | s1-none, s2-native, s3a-smart by size | 1–2 seeds/cell | context-research.md §Run B |
| D | d-sqlite + d-hybrid at 120k trim, 6 sizes × seeds 42–44 | 36 | `bench/results-D/`, chart source |
| Dp | search-tools pointer, log L1600 seed 44 only | 5 | `bench/results-Dp/` |
| Df | cache-stable trims, log L1600 seed 44 only | 5 | `bench/results-Df/` |

Weaknesses the plan must remove or confirm:

1. Baselines (run B) and smart (run D) come from different runs, LiteLLM builds and days; `docs/context-management.md:93` says so. The latency claim (trim request 4.0 s vs 1.7 s) is cross-run.
2. Df (the config quoted as current, `docs/context-management.md:125-139`) has n = 5 on **one task instance**, seed 44, the seed it was tuned on.
3. The README chart (`README.md:30-36`) and `site/src/data/contextbench.json` are run D (`site/scripts/bench/compute-contextbench.py:27-29` reads `results-B` s1/s2 and `results-D` d-sqlite); the text under it quotes Df. Chart and text disagree on config (120k vs 95k trim, pointer, cache fix).
4. The 5× cost ratio depends on Haiku 5.5's >100k price tier (`bench/summarize.py:31`, `PRICE[True]`); `context-management.md:139` already concedes total tokens differ <1.5×.
5. Native arm fired at a forced window (`bench/run_strict.sh:31` `NATIVE_WINDOW=153000`), not Claude Code's default.
6. No task scores the agent's own earlier decisions, the thing whole-turn eviction drops.

## 1. Hypotheses and decision rules (pre-registered)

Primary metric: `reward_lenient` per trial (kv tag-insensitive; `bench/summarize.py:120-135` `answer_check`). Secondary: list-price USD per trial (`summarize.py:37-43`), agent wall time (result.json via `bench/ctx_metrics.py`), request latency (`usage.jsonl` `latency_s`), peak prompt tokens, trims, native compactions.

| Id | Hypothesis | Disproved if |
| --- | --- | --- |
| H1 quality | Smart ≥ keep-everything on held-out seeds at R4000/L6400/L12800 | paired (same seed) mean difference smart − none < −0.05 with 95% bootstrap CI excluding 0 |
| H2 quality vs native | Smart > native (default) | paired difference ≤ 0 or CI includes 0 at n = 9 pairs per task family |
| H3 cost | Smart < native and < none per trial on Haiku | smart/none cost ratio CI includes 1.0, or smart > native on any family |
| H4 price-tier | On Sonnet (flat 1M pricing) smart's cost advantage shrinks but stays ≥ 1.3× over none via fewer tokens | Sonnet smart/none ratio CI includes 1.0 (then the cost story is Haiku-only; publish it as such) |
| H5 speed | Within one run, smart's agent wall time per trial is not slower than none by more than 20% | wall-time ratio smart/none > 1.2 with CI excluding 1.2 |
| H6 trim latency | Requests carrying a trim cost ≤ 1 s extra over the same arm's untrimmed requests | median difference > 1 s (then document the hook cost, do not hide it) |
| H7 decisions | Whole-turn eviction drops the agent's own decisions: smart without scratchpad scores < none on the decision task | smart ≥ none (then risk (c) is not observable here; accept as-is) |
| H8 scratchpad | Scratchpad restores H7: smart+scratchpad ≥ none and > smart | smart+scratchpad − smart ≤ 0 (then drop the feature) |

Statistics for every table: mean, n, 95% percentile-bootstrap CI (10,000 resamples), paired by seed where arms share seeds; report per family and pooled; list every trial (no exclusions beyond the pre-registered harness failures below). A trial is excluded only when `summarize.py` classes it rate-limited (`RATE_LIMIT_RE`, line 29), harness-failed (`cc_stream.py` no result event), or the proxy fail-opened (`events.kind = 'fail_open'`, `core.py:355`); excluded trials are listed and rerun once (`bench/rerun_strict.sh` pattern; `ctx/queue-E.txt` accepts appended lines, `ctx_sched.py:5`).

Null outcome is publishable: if H1–H3 fail, `context-management.md` Benchmarks is rewritten to say so and the README chart is removed.

## 2. Phases

Trial-cost and time anchors (list price; `results-D/d-sqlite/usage.jsonl`, `docs/context-research.md:152,184-195`, `context-management.md:83-88`):

| Cell | $ per trial | min per trial |
| --- | --- | --- |
| smart log L1600 (Df, 95k) | 0.11 | 7.3 |
| smart kv R4000 / log L6400 (run D, 120k) | 0.27 / 0.30 | 10–12 |
| smart log L12800 (run D) | 0.58 | 24 |
| none L1600 / R4000 / L6400 / L12800 (run B) | 0.57 / ~1.5 / ~1.5 / ~3 | 8–15 |
| native (forced 153k) L1600 / R4000 / L6400 | 0.31 / ~0.5 / ~0.5 | 8 |

Four trials run concurrently (`ctx_sched.py` MAX = 4). Wall time ≈ trials × 11 min / 4 + 20% for reruns.

### Phase 0: harness prep (no API spend, ~2 h)

Files:

- `bench/run_ctx.sh`: add run `E` with arms `e-none`, `e-native`, `e-smart`; ports in the table at lines 51-55 (next free: 4257–4259); `ARMS` case at 40-41; `TRIM_AT=` empty for E (line 45) so `MODEL_TRIM_AT_TOKENS` gives Haiku 95k (`proxy/openmem_context/settings.py:14`); `e-smart` at the current `main` SHA exported like `DF_SHA`/`R_DF` (lines 126-127; `./run_ctx.sh prep E`). `e-none`: pass-through proxy + `DISABLE_AUTO_COMPACT=1` (as `run_strict.sh:113`). `e-native`: pass-through proxy, **no** `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, **no** `DISABLE_AUTO_COMPACT` — Claude Code's default. Justification: the comparison a user sees is default Claude Code; the forced 153k window was a pilot artefact. If Claude Code's default never compacts under 1M on R4000 (then e-native ≡ e-none up to noise) the result still answers "what does the default do"; add a `e-native-95k` sensitivity arm (`CLAUDE_CODE_AUTO_COMPACT_WINDOW` sized to fire near 95k, confirmed in the first trial's `compactions` field, `cc_stream.py:171`) on log L6400 only, 3 seeds, +$1.5.
- Record every arm's exact env in the trial `config.json` (already Harbor's) and the proxy image tag (`D_IMAGE`, line 130) in `docs/context-research.md` run E header.
- `bench/ci.py` (new, ~60 lines): reads `summarize.py` trial rows, prints per-cell mean / n / bootstrap CI and paired differences by seed. `bench/stats.py` is a token-count script, not statistics; do not extend it.
- Seeds: 45, 46, 47 (held out; tasks already packaged: `bench/cb/tasks/*-seed45..49` exist for all sizes). Seed 44 is never used for scoring.
- Queue `bench/ctx/queue-E.txt`; run with `python bench/ctx_sched.py 4 ctx/queue-E.txt`; summarise with `python bench/summarize.py results-E state-E` and `python bench/ci.py results-E`.
- Smoke: one `e-smart` log L1600 seed 45 trial ($0.11) to confirm the 95k trim fires (`state-E/context/sessions/<sid>.log.jsonl`, `summarize.py:96-100`).

### Phase 1: three arms, same day, held-out seeds (H1–H3, H5, H6)

Cells: {e-none, e-native, e-smart} × {kv R4000, log L1600, log L6400, log L12800} × seeds {45, 46, 47}, except e-none at L12800 limited to 2 seeds (765k prompts, ~$3 each) and kv R16000 excluded (e-none hits the 979k step limit, not a recall score; `context-research.md` Limitations).

| Arm | Trials | $ |
| --- | --- | --- |
| e-smart | 12 | 3 × (0.11 + 0.27 + 0.30 + 0.58) = 3.8 |
| e-native (default) | 12 | 3 × (0.31 + 0.5 + 0.5 + 1.0) = 6.9 (if it never compacts, cost rises toward e-none: +5) |
| e-none | 11 | 3 × (0.57 + 1.5 + 1.5) + 2 × 3 = 16.7 |
| e-native-95k (optional) | 3 | 1.5 |
| reruns (20%) | ~7 | 5 |

Phase 1 total ≈ **$34**, 38 trials, ≈ 2.5–3 h wall. All arms interleaved in one queue so API load is shared.

Analysis: H1–H3 paired by seed; H5 from result.json agent wall time, same run; H6 **within e-smart**: `usage.jsonl` rows with `trimmed = 1` vs untrimmed rows of the same session, median and bootstrap CI of the difference, plus `events` table trim rows (`core.py:438`) for the hook's own time if recorded — check `record_usage` in `proxy/openmem_context/tokens.py`; if latency_s is measured outside the hook, say so. Also report requests per trial and searches per trial (sc_search, sc_sql columns, `summarize.py:232`).

Stop rule: if after the first 12 trials (one seed per cell) e-smart mean `reward_lenient` < e-none − 0.15, pause and write it up before spending more.

### Phase 2: scratchpad feature (no API spend, ~1 day)

Design (minimal; cache-safe):

- Storage: new table `pins (id INTEGER PRIMARY KEY, at TEXT, text TEXT)` as schema version 3 in `proxy/openmem_context/sessiondb.py` (migrations at lines 21-40; JS twin in `cli/mcp/context-store.mjs` / `cli/coding-agent/context-trim.mjs:370-381`).
- Write path: MCP tool `smart_compact_pin(session_id, text, replace=false)` in `cli/mcp/context-store.mjs` next to `smart_compact_search` (line 60); ≤ 2,000 chars total, newest-wins on `replace`; returns the current pinned block so it also sits in recent context.
- Read path: `_build_note` (`proxy/openmem_context/core.py:270-290`) appends `[openmem: pinned notes]\n<pins>` after `pointer_text`. The note is frozen per trim (`threads[root]["note"]`, line 416), so the pinned block changes only at trim time and the cached prefix stays byte-identical between trims. Pins written after a trim appear at the next trim; the tool result carries them meanwhile.
- Prompting: one sentence in `STANDING_INSTRUCTION` (`core.py:40`) and the pointer: "Decisions you must keep: smart_compact_pin(...)". Add the same to `cli/coding-agent/context-trim.mjs` for parity.
- Settings: `CONTEXT_PIN_MAX_CHARS` (default 2000) in `settings.py` dataclass (line 70+), 0 disables.

Tests:

- `proxy/tests/test_context_proxy.py` (87 tests; run `cd proxy && python3 -m pytest -q`, pytest from `bench/.venv/bin/pytest` if the host lacks it): trim note contains pins; pins survive a second trim; `replace` semantics; byte-identical note between two requests after one trim with a pin added in between (cache invariant).
- `proxy/tests/test_session_db.py`: schema v3 migration from v2 db.
- `scripts/tests/test_context_store.mjs` + new `scripts/tests/test_context_store_pin.mjs` (`npm test` runs `scripts/tests/test_*.mjs`, `package.json:88`): tool schema, cap, replace, read-only tools untouched.
- `scripts/tests/test_context_parity.mjs`: JS port renders the same note.
- Docs: `docs/context-management.md` tool table, `proxy/README.md` if it lists env vars, CLAUDE.md context section.

### Phase 3: decision-consistency task (H7, H8)

Research summary (what exists, why it does or does not fit):

| Benchmark | What it scores | Fit for (c) | Harness cost |
| --- | --- | --- | --- |
| ContextBench `sudoku_sketchpad` (vendored, `bench/cb/contextbench/tasks/sudoku_sketchpad`, tasks t4–t150 seeds 42–49) | agent tracks board state across turns; the grader folds actions | **Good**: the agent's own state, not user facts; already packaged for strict mode | zero |
| ContextBench `needle_retention` (vendored) | gold lines verbatim in the *final context window* | **Unusable**: scores retained context, so any trimmer scores 0 by construction | — |
| Compact-Bench Task Preservation ([arXiv 2610.31710](https://arxiv.org/abs/2610.31710)); adapter `bench/compact-bench-openmem/` exists, clone `bench/compact-bench` absent (needs commit 9dd9a3f) | continuation of SWE repairs after compaction of the agent's own progress | **Best external match** for (c) | high: repo venvs, 33 tasks, 2 at a time, several hours; defer to phase 6 |
| [LongMemEval](https://arxiv.org/abs/2410.10813), [LoCoMo](https://arxiv.org/abs/2402.17753), [MemoryAgentBench](https://arxiv.org/abs/2507.05257) | QA over user-supplied history (MemoryAgentBench adds conflict resolution) | tests retrieval of *given* facts, which kv/log already cover; none scores the agent's own decisions | medium: new stream adapter |

Decision: run **sudoku-sketchpad** (existing) and add one small family, `decision_ledger`, to `bench/cb/contextbench/tasks/` (register in `FAMILIES`, `bench/cb/contextbench/tasks/scaffold.py:25`; same `generate(seed, ...)` shape as `log_triage/generate.py:74`):

- Stream: N rounds. Round k gives the agent two or three valid options for item k ("pick the codename for service k from {A,B,C}") and asks it to reply `DECIDE k=<choice>`. Filler batches (log lines reused from `log_triage`) push the context past 95k. Then Q questions: "which codename did you pick for k?" → `ANSWER k=<choice>`, plus M "apply your choice" questions whose correct answer is a deterministic function of the earlier choice (e.g. "the port for k is 8000 + index of your choice").
- Grader (`bench/cb/contextbench/graders/decision.py`, mirrors `graders/log.py:64`): parse the agent's `DECIDE` lines from early turns (not from gold), compare each `ANSWER` to the agent's own decision; reward = fraction consistent. Deterministic; no LLM judge.
- Sizes: `D40-F1600` (40 decisions, 1,600 filler lines, ~110k tokens, one trim) and `D80-F6400` (3–4 trims). Seeds 45–47.

Cells: {e-none, e-smart, e-smart-pin} × {sudoku t150, ledger D40-F1600, ledger D80-F6400} × 3 seeds = 27 trials; e-native omitted (H7/H8 are about eviction, not summaries). Cost ≈ 27 × 0.35 = **$9.5**, ≈ 1.5 h.

Decision rules: H7, H8 as in §1. If `e-smart` scores ≥ `e-none` on both families, record "eviction loss not observed at these sizes" and ship the scratchpad only if H8's lift is ≥ 0.05 with CI excluding 0.

### Phase 4: Sonnet, one task, end of programme (H4)

Model `claude-sonnet-5` (confirm id against the LiteLLM route `bench/litellm/bench-config.yaml:7-12`; flat 1M pricing, so `PRICE` in `summarize.py:31` needs a per-model table — add `PRICES[model]`, and `site/scripts/bench/compute-contextbench.py` inherits it). Trim threshold: set `CONTEXT_TRIM_AT_TOKENS=95000` explicitly so the trim count matches Haiku and only price changes; default per-model would be 120k (`settings.py:11`).

Cells: {e-none, e-smart} × log L6400 × seeds {45, 46} = 4 trials. Cost per trial at Sonnet rates (~20× Haiku base, no cliff): none ≈ 10M tokens mostly cache reads ≈ $4–6; smart ≈ 7M ≈ $2–3. Total ≈ **$16**; abort after the first pair if it exceeds $10. Report cost ratio with CI and the token ratio; H4 decides how the cost claim is worded.

### Phase 5: threshold ablation (optional, cheap)

Only if phase 1 shows trims drive cost (cost correlates with trim count across trials, Spearman ρ > 0.5). e-smart only, log L6400 seed 45, grid `CONTEXT_TRIM_AT_TOKENS ∈ {60k, 95k, 120k}` × `CONTEXT_TRIM_TO_FRACTION ∈ {0.3, 0.6}` (`settings.py:16,80,111`), 1 trial each = 6 trials ≈ **$2**, 40 min. Report score, cost, trims, cache hit rate; pick nothing from it without a confirmation seed.

### Phase 6 (deferred, not budgeted): Compact-Bench Task Preservation

Re-clone `cai-jianfeng/compact-bench` at 9dd9a3f into `bench/compact-bench`, run `bench/compact-bench-openmem/run.sh --instance pylint-dev__pylint-6903 --methods claude,openmem --rounds 1` as smoke, then `drive.py`. Needs its own budget line (33 tasks × 4 methods on Haiku; estimate after the smoke).

### Cheap aside for risk (a)

In phase 1 e-smart trials Claude Code's auto-compaction is disabled. One extra e-smart trial on log L6400 with `DISABLE_AUTO_COMPACT` unset ($0.30) shows whether the two managers ever collide at 95k; record `compactions` and trims. Not prioritised.

## 3. Budget and schedule

| Phase | Trials | $ | Wall |
| --- | --- | --- | --- |
| 0 prep + smoke | 1 | 0.1 | 2 h build |
| 1 three arms | 38 | 34 | 3 h |
| 2 scratchpad | 0 | 0 | 1 day build |
| 3 decision task | 27 | 9.5 | 1.5 h + 0.5 day build |
| 4 Sonnet | 4 | 16 | 1 h |
| 5 ablation | 6 | 2 | 40 min |
| a aside | 1 | 0.3 | — |
| **Total** | **77** | **≈ 62 (cap 75)** | 2.5 days build, ~6 h run |

Phase 4 is the overrun risk; its abort rule keeps the programme under $60 if Sonnet costs come in high.

## 4. Harness pitfalls (from the code)

- Retries must `--resume`; a retried turn with `--session-id` collides (`bench/cc_stream.py:345`). Retry events are counted in `cc_retry_events` (`summarize.py:203`).
- Rate limits: `RATE_LIMIT_RE` (`summarize.py:29`) classes 429/529/overloaded; run B lost trials to this. Keep MAX = 4 concurrent; stagger is 5 s (`ctx_sched.py:28`).
- Ports are hard-coded per run:arm (`run_ctx.sh:51-55`); a new run needs new entries or proxies collide.
- `TRIM_AT` semantics: unset → 120000; set-empty → proxy per-model threshold (`run_strict.sh:29`, `run_ctx.sh:45`).
- kv `#tag` drops make strict `reward` 0 while values are right; compare `reward_lenient`, rerun format-invalid trials with `bench/rerun_strict.sh`.
- `ctx_sched.py` skips tasks whose dir is missing (`ctx/skipped.txt`) and only exits when `ctx/STOP` exists.
- Results dirs contain root-owned files from Docker; write summaries elsewhere (`bench/ctx/`), never edit `results-*`.
- `needle_retention` grades the final context window; do not run it against any trimming arm.
- Counts in log-triage overcount when the agent's own output echoes log lines (`context-research.md` "Echo overcount"); unchanged in run E, reported separately as `count` sub-score.
- The proxy's `fail_open` event means an untrimmed request went out silently (`core.py:355`); check `events` per session before scoring an e-smart trial.
- `latency_s` in `usage.jsonl` may or may not include the pre-call hook; verify in `tokens.py:record_usage` before claiming H6.

## 5. Docs to update after the runs

- `docs/context-research.md`: new "Run E" section (method, every trial, CIs, exclusions), "Run E-S" (Sonnet), "Run E-D" (decision task), Limitations rewritten, Next steps pruned.
- `docs/context-management.md`: Benchmarks tables and Time/Cost sections regenerated from run E (same-run baselines; drop the cross-run caveat at line 93); the "three changes since" block (lines 125-139) folds into the main table; scratchpad tool documented.
- `site/scripts/bench/compute-contextbench.py:27-29`: point at `results-E/state-E` for all three arms; add per-model prices; `cd site && pnpm media` regenerates `contextbench-*.png`; `site/src/data/contextbench.json` committed.
- `README.md:30-36`: chart alt text and link; today the chart is run D (120k trim, no pointer) while the text quotes Df, fix by regenerating from run E. If H1–H3 fail, replace the chart with the null result sentence.
- `CLAUDE.md`: bench section mentions run E layout and `bench/ci.py`.
