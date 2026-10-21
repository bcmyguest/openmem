# Coding-agent session hooks (parity)

Hindsight ships session retain/recall/reflect through
[`@vectorize-io/hindsight-coding-agents`](https://www.npmjs.com/package/@vectorize-io/hindsight-coding-agents).
Other providers use the **same UX goals** but different backends: personal-memory routes
session-style work through the **unified MCP** (`memory_*`) until a dedicated plugin exists.

## Capability matrix

| Capability | Hindsight plugin | mem0 (MCP shim) | Cognee (MCP shim) |
| --- | --- | --- | --- |
| retain | yes | yes (`memory_add`) | yes (`memory_add`) |
| recall / search | yes | yes (`memory_recall`) | yes (`memory_search`) |
| reflect | yes | no | no |
| consolidate | yes (via LiteLLM routes) | no | no |
| bank / scope | Hindsight banks | mem0 `user_id` | Cognee dataset |

Flags live in `cli/coding-agent/capabilities.mjs`; `doctor wiring` and
`install-coding-agent` read the same table. `npx personal-memory wiring` prints
which session features work for the active provider (reflect/consolidate are Hindsight-only today).

## Install per agent

```sh
npx personal-memory install-coding-agent --yes
```

- **Hindsight:** runs the upstream `hindsight-coding-agents install` plan for Claude Code, Codex, OpenCode, and Cursor CLI.
- **mem0 / Cognee:** prints MCP-first session guidance and ensures `install-mcp` merged the unified server.

See [MCP install guide](mcp-install-guide.md) and [coding agents](coding-agents.md).

## Session scopes

Indexer banks map to provider scopes (`coding-agent::repo`, `obsidian::vault`, mem0 `user_id`, Cognee dataset names). Default MCP scope key: `personal-memory-mcp`. See [coding-agent-scopes.md](coding-agent-scopes.md).
