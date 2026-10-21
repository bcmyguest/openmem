# Coding-agent session hooks (parity)

Hindsight ships session retain/recall/reflect through
[`@vectorize-io/hindsight-coding-agents`](https://www.npmjs.com/package/@vectorize-io/hindsight-coding-agents).
Other providers use the **same UX goals** but different backends: personal-memory routes
session-style work through the **unified MCP** (`memory_*`) until a dedicated plugin exists.

## Capability matrix

| Capability | Hindsight (default shim) | mem0 (session shim) | Cognee (session shim) |
| --- | --- | --- | --- |
| retain | yes | yes (Stop hook → `memory_add`) | yes |
| recall / search | yes | yes (prompt hook → `memory_recall`) | yes |
| reflect | yes (`memory_reflect` → Hindsight recall) | yes (`memory_reflect` → search + optional LiteLLM) | yes (search + LiteLLM or raw hits) |
| consolidate | yes (Hindsight/LiteLLM routes) | no | yes (`memory_consolidate` → cognify) |
| bank / scope | Hindsight banks | mem0 `user_id` | Cognee dataset |

Flags live in `cli/coding-agent/capabilities.mjs`; `doctor wiring` and
`install-coding-agent` read the same table. `npx personal-memory wiring` prints
which session features work for the active provider.

## Install per agent

```sh
npx personal-memory install-coding-agent --yes
```

- **All providers:** `install-mcp` + **in-repo session hooks** (`cli/coding-agent/hook-runner.mjs`) for Claude Code, Codex, Cursor CLI, and an OpenCode plugin.
- **Optional:** `--hindsight-plugin` with `MEMORY_PROVIDER=hindsight` also runs `@vectorize-io/hindsight-coding-agents install` (legacy/alternate hook set).

See [MCP install guide](mcp-install-guide.md) and [coding agents](coding-agents.md).

## Session scopes

Indexer banks map to provider scopes (`coding-agent::repo`, `obsidian::vault`, mem0 `user_id`, Cognee dataset names). Default MCP scope key: `personal-memory-mcp`. See [coding-agent-scopes.md](coding-agent-scopes.md).
