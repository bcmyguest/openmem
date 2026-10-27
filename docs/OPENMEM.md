# OpenMem

**OpenMem** is the product name for this repository (formerly *personal-memory*).

## What it is

An **interface layer** for coding-agent memory:

- **Providers** — swap backends via manifests (`providers/*/`), compose, indexer sinks, and wizard hooks. Hindsight, mem0, and Cognee ship today.
- **Agent surface** — one skill, unified `memory_*` MCP, and session hooks across Claude Code, Codex, Cursor, and OpenCode.
- **Portability** — import/export through a format layer. **PMM** (Personal Memory Manifest) is the first format; more formats plug into the same orchestrator (`cli/mcp/portability.mjs`).

OpenMem does not replace Hindsight, mem0, or Cognee. It owns machine plumbing and agent wiring so those engines stay interchangeable.

## CLI

| Preferred | Alias (compat) |
| --- | --- |
| `npx openmem` | `npx personal-memory` |
| `openmem` | `personal-memory` |

Machine config paths under `~/.config/personal-memory/` and `~/.config/hindsight/` stay as-is for now so existing installs keep working.

## Repo

- GitHub: [bcmyguest/openmem](https://github.com/bcmyguest/openmem)
- npm: `openmem` (package formerly `personal-memory`)
