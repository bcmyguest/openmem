# Compatibility matrix

What OpenMem supports per coding agent and per memory provider, as of branch `feat/openmem-context-layer` (2026-10-29). Each cell records the strongest evidence that exists, not intent.

| Mark | Meaning |
| --- | --- |
| ✅ | Verified live against a real agent or server |
| 🧪 | Implemented and covered by automated tests; not yet verified live |
| ◐ | Partial or best effort; see the note |
| ❌ | Not supported |

## Coding agents

`install-coding-agent` wires the first five columns. Hermes, Gemini CLI, Amp and Cline get the unified MCP through `install-mcp` and their own MCP configuration; nothing else.

| Feature | Claude Code | Codex CLI | Cursor CLI | OpenCode 1.x | OpenCode 2.x |
| --- | --- | --- | --- | --- | --- |
| Unified `memory_*` MCP | 🧪 ⁸ | 🧪 | 🧪 ⁸ | 🧪 ⁸ | ❌ ¹ |
| OpenMem skill | 🧪 | 🧪 | 🧪 | 🧪 | ❌ ¹ |
| Startup banner + recall | 🧪 | 🧪 ² | 🧪 ³ | 🧪 ¹³ | 🧪 ⁹ ¹³ |
| Repository auto-registration | ◐ ¹⁴ | ◐ ¹⁴ | ◐ ¹⁴ | ◐ ¹⁴ | ◐ ¹⁴ |
| Per-prompt recall | 🧪 | 🧪 | 🧪 ³ | 🧪 | ✅ ⁹ |
| Turn retention (Stop / idle) | 🧪 | ◐ ⁴ | ◐ ⁵ | 🧪 | ✅ ⁹ ¹⁰ |
| `[agents] integration` toggle | 🧪 ¹² | 🧪 ¹² | 🧪 ¹² | 🧪 ¹² | 🧪 ¹¹ |
| rtk command rewriting (`rtk init`) | 🧪 ⁶ | 🧪 ⁶ | 🧪 ⁶ | 🧪 ⁶ | ❌ ⁷ |

1. Not built for OpenCode 2. OpenCode 2 replaced the plugin API ([migration guide](https://opencode.ai/v2/docs/build/plugins/migrate-v1/)) and its config shape (`"plugins"`, `"providers"`); the installer's MCP and skill wiring for OpenCode was written for OpenCode 1 and has not been checked against OpenCode 2.
2. Codex runs non-managed hooks only after review in `/hooks` ([Codex hooks](https://developers.openai.com/codex/hooks)).
3. Cursor hooks now go under `"hooks"` in `~/.cursor/hooks.json` (Cursor's documented shape). Earlier OpenMem releases wrote them at the top level, where Cursor does not read them.
4. Codex does not guarantee a stable transcript format; unknown rows are skipped.
5. Cursor Stop retention parses the observed local `agent-transcripts` JSONL shape; live hook `transcript_path` linkage is unverified.
6. Tested with a fake `rtk` that records its arguments; flags taken from rtk's README and source. No real rtk binary was run.
7. Tracked upstream in [rtk-ai/rtk#3463](https://github.com/rtk-ai/rtk/issues/3463).
8. MCP connection checks recorded in `REVAMP.md` (Claude Code, OpenCode; Cursor listed nine tools) ran against the earlier nine-tool list. The current 15 tools add the page, status and initiative tools, which were checked through the facade only, not listed or called inside any agent.
9. Checked once live with OpenCode 2.2.1 (`@opencode/cli-linux-x64`, run from a temp directory with temp `HOME`/XDG dirs and `opencode run --standalone`) against a loopback fake OpenAI-compatible model and a fake Hindsight API, with a plugin build that also trimmed context (removed in 0.10). Requests reached the fake model with the memory system part and the per-prompt recall. Hindsight was a fake server: recall content and retention never touched a real Hindsight. Not checked against a real model provider either. `scripts/tests/test_opencode2_plugin.mjs` covers the same paths with a fake `ctx`.
10. Retention runs from the `experimental.idle` session hook (typed in `@opencode/plugin` 2.2.1; not in the server docs), with `session.execution.succeeded`, `session.status` idle and `session.idle` events as fallbacks. OpenCode 2.2.1 published neither `session.status` nor `session.idle` to the plugin.
11. The installer runs `opencode --version` (major 2 → `"plugins"` directory entry, anything else → `"plugin"` file entry) and removes the other shape. Tested with a fake `opencode` on `PATH`. The installer itself was not run against a real OpenCode 2 install; the live check configured the plugin directory by hand.
12. `openmem` mode removes the upstream Hindsight hooks, OpenCode plugin entry, `hindsight` MCP server (only when it runs the upstream `dist/mcp-server.js`) and `hindsight-coding-agent` skill. Locations come from reading `@vectorize-io/hindsight-coding-agents` 0.8.3 `dist/installer.js`; tested against seeded files, not a live upstream install.
13. At 2c1a245 neither OpenCode plugin emitted a startup banner; banners are being added on this branch and are not yet verified live. For OpenCode 2, per-prompt recall through the prompt hook reached the model live (footnote 15).
14. `autoRegisterLocation` (`cli/coding-agent/access-policy.mjs`) is covered by `scripts/tests/test_auto_register.mjs`. The call sites in the SessionStart hook and both OpenCode plugins have no automated test and were not run in a live agent.

Copilot and Pi are not in OpenMem's agent registry. rtk supports both.

OpenMem 0.10 removed context management (context proxy, session store, `smart_compact_*` tools, OpenCode 2 trim); its rows moved to [Smarter Compact](https://github.com/bcmyguest/smarter-compact).

## Memory providers

| Capability | Hindsight | mem0 | Cognee |
| --- | --- | --- | --- |
| `memory_recall` / `memory_search` | ✅ | 🧪 | 🧪 |
| `memory_add` | 🧪 | 🧪 | 🧪 |
| `memory_reflect` | ✅ native `/reflect` | 🧪 search + optional LiteLLM synthesis | 🧪 search + optional LiteLLM synthesis |
| `memory_consolidate` | 🧪 | ❌ no-op | 🧪 cognify |
| `memory_pages_list` / `search` / `read` | ✅ | ❌ `supported: false` | ❌ `supported: false` |
| `memory_capture_initiative` | 🧪 | ❌ `supported: false` | ❌ `supported: false` |
| `memory_status` (ingest drained, per-operation) | ✅ | 🧪 always ready (synchronous ingest) | ❌ `supported: false` |
| `memory_export` / `memory_import` (PMM) | 🧪 | 🧪 | 🧪 |

"✅" for Hindsight means the call succeeded against the live server on this machine (28 banks, 41,701 facts); `memory_recall` and `memory_reflect` evidence is from `REVAMP.md`, the page and status tools from this branch. mem0 and Cognee rows are covered by facade tests with stubbed HTTP.

## Hindsight model backends (wizard step 3)

| Backend | Status |
| --- | --- |
| Ollama in Compose (profile `ollama`) | ✅ retain, reflect and consolidate answered through LiteLLM v1.106.6 |
| Ollama on the host | 🧪 |
| lemond on the host | 🧪 |
| Custom OpenAI-compatible URL | 🧪 |
| Claude subscription via Meridian | 🧪 stub server only; see [Meridian guide](meridian-litellm.md) |
