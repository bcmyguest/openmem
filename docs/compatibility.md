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
| Unified `memory_*` MCP | ✅ ¹⁴ | 🧪 | ✅ ¹⁴ | ✅ ¹⁴ | ❌ ¹ |
| OpenMem skill | 🧪 | 🧪 | 🧪 | 🧪 | ❌ ¹ |
| Startup banner + recall | 🧪 | 🧪 ² | 🧪 ³ | 🧪 (prompt hook) | ❌ ¹ |
| Session registration (`sessions/<sid>.json`) | 🧪 | 🧪 | 🧪 ³ | 🧪 ⁴ | ❌ ¹ |
| Per-prompt recall | 🧪 | 🧪 | 🧪 ³ | 🧪 | ❌ ¹ |
| Turn retention (Stop / idle) | 🧪 | ◐ ⁵ | ◐ ⁶ | 🧪 | ❌ ¹ |
| `/smart-compact` trim flag | 🧪 ⁷ | 🧪 | 🧪 | 🧪 | ❌ ¹ |
| Context proxy (trim, tool-result compression) | ✅ ⁸ | ❌ ⁹ | ❌ ¹⁰ | ◐ ¹¹ | ❌ ¹ |
| `[agents] integration` toggle | 🧪 | 🧪 | 🧪 | 🧪 | ❌ ¹ |
| rtk command rewriting (`rtk init`) | 🧪 ¹² | 🧪 ¹² | 🧪 ¹² | 🧪 ¹² | ❌ ¹³ |

1. OpenCode 2 replaced the plugin API ([migration guide](https://opencode.ai/v2/docs/build/plugins/migrate-v1/)): plugins export `Plugin.define({ id, setup })`, config uses `"plugins"` instead of `"plugin"`, and v1 plugins do not load. OpenMem's plugin is v1-shaped. The v2 API has the hooks a port needs: `ctx.session.hook("context")` (edit `system` and `messages`), `"prompt"`, `"compaction"`, `"http.request"`, and `ctx.event.subscribe()`.
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
14. MCP connection checks recorded in `REVAMP.md` (Claude Code, OpenCode; Cursor listed the tools). The tool list has grown since; the new tools were checked through the facade, not inside each agent.

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
