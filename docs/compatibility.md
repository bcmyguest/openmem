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
| Unified `memory_*` MCP | 🧪 ¹⁴ | 🧪 | 🧪 ¹⁴ | 🧪 ¹⁴ | ❌ ¹ |
| OpenMem skill | 🧪 | 🧪 | 🧪 | 🧪 | ❌ ¹ |
| Startup banner + recall | 🧪 | 🧪 ² | 🧪 ³ | 🧪 ²² | 🧪 ¹⁵ ²² |
| Session registration (`sessions/<sid>.json`) | 🧪 | 🧪 | 🧪 ³ | 🧪 ⁴ | ✅ ¹⁵ ¹⁶ |
| Per-prompt recall | 🧪 | 🧪 | 🧪 ³ | 🧪 | ✅ ¹⁵ |
| Turn retention (Stop / idle) | 🧪 | ◐ ⁵ | ◐ ⁶ | 🧪 | ✅ ¹⁵ ¹⁷ |
| `/smart-compact` trim flag | 🧪 ⁷ | 🧪 | 🧪 | 🧪 | ✅ ¹⁵ ¹⁸ |
| Context proxy (trim, tool-result compression) | ✅ ⁸ | ❌ ⁹ | ❌ ¹⁰ | ◐ ¹¹ | ✅ native ¹⁵ ¹⁹ |
| Agent compaction replaced by pointer + recall | ❌ | ❌ | ❌ | ❌ | ✅ ¹⁵ (`[compaction] native`) |
| `[agents] integration` toggle | 🧪 ²¹ | 🧪 ²¹ | 🧪 ²¹ | 🧪 ²¹ | 🧪 ²⁰ |
| rtk command rewriting (`rtk init`) | 🧪 ¹² | 🧪 ¹² | 🧪 ¹² | 🧪 ¹² | ❌ ¹³ |

1. Not built for OpenCode 2. OpenCode 2 replaced the plugin API ([migration guide](https://opencode.ai/v2/docs/build/plugins/migrate-v1/)) and its config shape (`"plugins"`, `"providers"`); the installer's MCP and skill wiring for OpenCode was written for OpenCode 1 and has not been checked against OpenCode 2.
2. Codex runs non-managed hooks only after review in `/hooks` ([Codex hooks](https://developers.openai.com/codex/hooks)).
3. Cursor hooks now go under `"hooks"` in `~/.cursor/hooks.json` (Cursor's documented shape). Earlier OpenMem releases wrote them at the top level, where Cursor does not read them.
4. The plugin registers on `session.created` and, when `context-proxy.env` exists, sends `x-openmem-session-id` through `chat.headers`, so the proxy keys OpenCode trims by the real session id. Neither is verified in a live OpenCode session.
5. Codex does not guarantee a stable transcript format; unknown rows are skipped.
6. Cursor Stop retention parses the observed local `agent-transcripts` JSONL shape; live hook `transcript_path` linkage is unverified.
7. Detects the typed `/smart-compact`, the expanded `<command-name>` tag, and an `openmem:smart-compact` marker; which form Claude Code passes to UserPromptSubmit is unverified.
8. Verified with `claude -p` on a Claude subscription through LiteLLM v1.106.6: OAuth forwarding, streaming, signed thinking blocks, trims on resumed sessions, compressed tool results, recall injection, prompt-cache reads after a trim. Wiring through `install-coding-agent --context-proxy` (settings.json `env`) is test-covered only.
9. Codex signs in with ChatGPT. LiteLLM forwards ChatGPT-login traffic only from v1.109.0-dev.1 (PR #41522); no stable release includes it. A live request through the dev build reached `chatgpt.com/backend-api/codex/responses` and the hook fired.
10. Whether Cursor CLI accepts a custom model base URL is unverified.
11. The installer sets `provider.anthropic.options.baseURL` and `headers`; whether OpenCode applies `headers` to its built-in Anthropic provider is unverified. Chat Completions and Responses trimming is unit-tested only.
12. Tested with a fake `rtk` that records its arguments; flags taken from rtk's README and source. No real rtk binary was run.
13. Tracked upstream in [rtk-ai/rtk#3463](https://github.com/rtk-ai/rtk/issues/3463).
14. MCP connection checks recorded in `REVAMP.md` (Claude Code, OpenCode; Cursor listed nine tools) ran against the earlier nine-tool list. The current 18 tools add the page, status, initiative and `smart_compact_*` tools, which were checked through the facade only, not listed or called inside any agent.
15. Checked once live with OpenCode 2.2.1 (`@opencode/cli-linux-x64`, run from a temp directory with temp `HOME`/XDG dirs and `opencode run --standalone`) against a loopback fake OpenAI-compatible model and a fake Hindsight API. Requests reached the fake model with the memory system part, the trimmed messages, the pointer plus recall plus ingest note, and the byte-identical sticky prefix on later turns. A sandbox helper plugin triggered compaction through `ctx.session.compact`; OpenCode stored the plugin's summary as a completed compaction and made no summary model call. Hindsight was a fake server: recall content, retention and the ingest note never touched a real Hindsight. Not checked against a real model provider either. `scripts/tests/test_opencode2_plugin.mjs` and `test_context_trim.mjs` cover the same paths with a fake `ctx`.
16. OpenCode 2.2.1 loaded the location's plugins after `opencode run` had created the session, so no `session.created` event arrived. The plugin registers on the first `prompt` or `context` hook call instead.
17. Retention runs from the `experimental.idle` session hook (typed in `@opencode/plugin` 2.2.1; not in the server docs), with `session.execution.succeeded`, `session.status` idle and `session.idle` events as fallbacks. OpenCode 2.2.1 published neither `session.status` nor `session.idle` to the plugin.
18. Typed `/smart-compact` through `opencode run` arrived as prompt text, and the next request was trimmed. The plugin also registers a `smart-compact` command through `ctx.command.transform`; that path is test-covered only.
19. OpenCode 2 is never pointed at the context proxy; the plugin trims in its `context` hook ([context proxy](context-proxy.md)). The trim was checked live (footnote 15); tool-result compression is test-covered only, including byte parity with the proxy's `compress_text`.
20. The installer runs `opencode --version` (major 2 → `"plugins"` directory entry, anything else → `"plugin"` file entry), removes the other shape and skips proxy wiring for OpenCode 2. Tested with a fake `opencode` on `PATH`. The installer itself was not run against a real OpenCode 2 install; the live check configured the plugin directory by hand.
21. `openmem` mode removes the upstream Hindsight hooks, OpenCode plugin entry, `hindsight` MCP server (only when it runs the upstream `dist/mcp-server.js`) and `hindsight-coding-agent` skill. Locations come from reading `@vectorize-io/hindsight-coding-agents` 0.8.3 `dist/installer.js`; tested against seeded files, not a live upstream install.
22. At 2c1a245 neither OpenCode plugin emitted a startup banner; banners are being added on this branch and are not yet verified live. For OpenCode 2, per-prompt recall through the prompt hook reached the model live (footnote 15).

Copilot and Pi are not in OpenMem's agent registry. rtk supports both; Pi can point at the context proxy only if it accepts a custom Anthropic base URL (unverified).

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
| `smart_compact_search` / `smart_compact_get` | 🧪 local files, provider-independent | 🧪 | 🧪 |
| Proxy recall injection after a trim | ✅ | ❌ | ❌ |
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
