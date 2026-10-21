# MCP install guide

personal-memory can register several **independent** stdio MCP servers in `~/.cursor/mcp.json`.
They differ by tool names, which API they call, and whether they depend on Hindsight. Use this guide
to pick the right combination; day-to-day defaults are covered in [Quickstart](quickstart.md) and
[Architecture](architecture.md).

## Three MCP families

| Server key (typical) | Install path | Tools (examples) | Backend |
| --- | --- | --- | --- |
| **`personal-memory`** | Default `install-mcp` | `memory_add`, `memory_search`, `memory_recall`, `memory_reflect`, `memory_consolidate`, `memory_forget`, `memory_provider_status`, export/import | Active provider (`MEMORY_PROVIDER` / `wizard.conf`): Hindsight, mem0, or Cognee HTTP |
| **Provider-native** (`mem0`, `cognee`) | `install-mcp --provider-only` | mem0: upstream `@yeyuan98/mem0-mcp` names; Cognee: `cognee_health`, `cognee_search` | Same API as the stack, **different** tool surface |
| **`notebooklm`** | `install-mcp` when sync on, or `--notebooklm` / `--notebooklm-only` | `notebooklm_list_banks`, `notebooklm_search` | `notebooklm::*` scope on the **active** provider (sync + MCP follow `MEMORY_PROVIDER`) — **not** a memory provider |

**Hindsight in-editor session memory** is not an MCP entry: the
[`@vectorize-io/hindsight-coding-agents`](https://www.npmjs.com/package/@vectorize-io/hindsight-coding-agents)
plugin (wizard coding-agent step). Unified MCP complements that with stable cross-provider tools.

NotebookLM MCP is **read-only search** over synced notebooks. It does not replace project indexing,
mem0, Cognee, or Hindsight retain/recall for coding work. Details: [NotebookLM](notebooklm.md).

## When to use which

### Default: unified MCP (`npx personal-memory install-mcp --yes`)

Use this when you want **one tool contract** (`memory_*`) that follows
`npx personal-memory switch <id>` without rewriting agent prompts.

- Merges the `personal-memory` server (unless `--no-unified-mcp`).
- Also merges **NotebookLM** MCP when `~/.config/hindsight/notebooklm.yml` has `enabled: true`, or
  you pass **`--notebooklm`** (sets `notebooklmAccess.enabled` and merges the server).
- For **`MEMORY_PROVIDER=hindsight`**, there is no separate “provider MCP” step — only the unified
  server (+ optional NotebookLM) and the coding-agents plugin.

Good for: Cursor agents, automation, and docs that assume `memory_add` / `memory_search`.

### Provider-native MCP (`--provider-only`)

Use when you already have prompts or integrations written for **upstream tool names**:

- **mem0:** `@yeyuan98/mem0-mcp` via `cli/mem0-mcp.mjs` (URL + path to `mem0.env` in `mcp.json` —
  **never** the API key in JSON).
- **Cognee:** read-only `cli/cognee-mcp.mjs` (`COGNEE_API_URL` only in `mcp.json`).

`install-mcp --provider-only` **skips NotebookLM** even if sync is enabled. It still merges the
**unified** `personal-memory` server by default (same as a plain `install-mcp` for mem0/Cognee unless
you also pass `--no-unified-mcp`). `switch <id> --yes` runs `install-mcp --provider-only` to refresh
native mem0/Cognee entries after a provider change.

Good for: mem0/Cognee-specific tutorials, comparing behavior to upstream MCP, or running native tools
**alongside** unified tools (both can coexist in `mcp.json`).

Skip unified entirely: `install-mcp --yes --provider-only --no-unified-mcp`.

### NotebookLM MCP only (`--notebooklm-only`)

Use when Hindsight is your memory stack, NotebookLM sync is already on (or you will enable it), and
you only need to (re)register **`notebooklm`** MCP + `notebooklmAccess` without touching mem0/Cognee
provider entries.

Mutually exclusive with **`--provider-only`**.

Force NotebookLM when sync is off: **`--notebooklm`** (enables access flag and merges MCP).

## Flags reference

```sh
npx personal-memory install-mcp --yes          # unified + NotebookLM if sync enabled
npx personal-memory install-mcp --yes --notebooklm
npx personal-memory install-mcp --yes --notebooklm-only
MEMORY_PROVIDER=mem0 npx personal-memory install-mcp --yes --provider-only
npx personal-memory install-mcp --yes --no-unified-mcp
npx personal-memory install-mcp --dry-run
```

| Flag | Effect |
| --- | --- |
| `--yes` | No confirmation prompt |
| `--dry-run` | Print plan; do not write `mcp.json` or coding-agent.json |
| `--notebooklm` | Enable NotebookLM agent access + merge `notebooklm` MCP |
| `--notebooklm-only` | Only NotebookLM step |
| `--provider-only` | Install mem0/Cognee native MCP for active provider; skip NotebookLM |
| `--no-unified-mcp` | Do not merge `personal-memory` unified server |

**Provider resolution:** `MEMORY_PROVIDER` → `~/.config/hindsight/wizard.conf` → `hindsight`.

**Merge behavior:** Existing `hindsight`, `codegraph`, and `notebooklm` entries are preserved;
mem0/Cognee entries are updated for the active provider. Restart Cursor Agent after changes.

## How unified tools map to providers

Same table as [Architecture — Unified MCP → provider HTTP](architecture.md#unified-mcp--provider-http).
Indexer bank semantics align with MCP `bank` / filters / datasets — see [Indexer sink drivers](indexer-sinks.md).

## Related

- [Coding agents and MCP](coding-agents.md) — plugin install, switch, doctor
- [mem0](mem0.md) / [Cognee](cognee.md) — operator URLs and secrets
- [Memory portability](memory-portability.md) — `memory_export` / `memory_import`
