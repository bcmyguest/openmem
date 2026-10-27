# MCP setup

OpenMem registers **stdio MCP servers** in `~/.cursor/mcp.json` (and wires session hooks via `install-coding-agent`). Day-to-day you want the **unified** `openmem` server (`memory_*` tools). Provider-native and NotebookLM servers are optional add-ons.

For why this exists, see [Concepts](concepts.md). Install path: [Quickstart § Wire your coding agent](quickstart.md#3-wire-your-coding-agent-optional).

## Quick path (recommended)

```sh
npx @bcmyguest/openmem install-coding-agent --yes
```

That installs:

1. Unified MCP (`openmem`) — `memory_add`, `memory_search`, `memory_recall`, `memory_reflect`, `memory_consolidate`, `memory_forget`, `memory_export` / `memory_import`, ops tools
2. OpenMem skill + session hooks (Claude Code, Codex, OpenCode, Cursor CLI)

MCP only (no session hooks):

```sh
npx @bcmyguest/openmem install-mcp --yes
```

Restart **Cursor Agent** (or your agent’s MCP host) after changes.

## Server families

| Server key | How to install | Tools | Backend |
| --- | --- | --- | --- |
| **`openmem`** | Default `install-mcp` / `install-coding-agent` | Stable `memory_*` | Active provider (`MEMORY_PROVIDER`): Hindsight, mem0, or Cognee |
| **Provider-native** (`mem0`, `cognee`) | `install-mcp --provider-only` | Upstream / repo-specific names | Same HTTP API, different tool surface |
| **`notebooklm`** | When NotebookLM sync is on, or `--notebooklm` | `notebooklm_list_banks`, `notebooklm_search` | Search over synced notebooks on the **active** provider — not a memory engine |

Hindsight’s optional in-editor plugin (`--hindsight-plugin`) is **not** an MCP entry; it complements unified MCP on Hindsight stacks. See [Hindsight](hindsight.md).

## When to use which

### Default: unified `memory_*`

Use when you want one tool contract that survives `npx @bcmyguest/openmem switch <provider>` without rewriting prompts.

```sh
npx @bcmyguest/openmem install-mcp --yes
npx @bcmyguest/openmem install-mcp --yes --notebooklm   # also force NotebookLM MCP
```

### Provider-native (optional)

Use when you already have prompts for upstream tool names:

```sh
MEMORY_PROVIDER=mem0 npx @bcmyguest/openmem install-mcp --yes --provider-only
npx @bcmyguest/openmem install-mcp --yes --provider-only   # Cognee when active
```

- **mem0:** `cli/mem0-mcp.mjs` → `@yeyuan98/mem0-mcp` (URL + path to `mem0.env` in JSON — never the key). Details: [mem0](mem0.md).
- **Cognee:** `cli/cognee-mcp.mjs` (`cognee_health`, `cognee_search`; `COGNEE_API_URL` only). Details: [Cognee](cognee.md).

`install-mcp --provider-only` still merges unified `openmem` unless you also pass `--no-unified-mcp`. Both can coexist in `mcp.json`.

### NotebookLM only

```sh
npx @bcmyguest/openmem install-mcp --yes --notebooklm-only
```

Mutually exclusive with `--provider-only`. Read-only search over synced notebooks — not a substitute for project indexing or `memory_*`.

## Flags

```sh
npx @bcmyguest/openmem install-mcp --yes
npx @bcmyguest/openmem install-mcp --yes --notebooklm
npx @bcmyguest/openmem install-mcp --yes --notebooklm-only
MEMORY_PROVIDER=mem0 npx @bcmyguest/openmem install-mcp --yes --provider-only
npx @bcmyguest/openmem install-mcp --yes --no-unified-mcp
npx @bcmyguest/openmem install-mcp --dry-run
```

| Flag | Effect |
| --- | --- |
| `--yes` | No confirmation prompt |
| `--dry-run` | Print plan; do not write configs |
| `--notebooklm` | Enable NotebookLM agent access + merge `notebooklm` MCP |
| `--notebooklm-only` | Only NotebookLM step |
| `--provider-only` | Native mem0/Cognee MCP for active provider; skip NotebookLM |
| `--no-unified-mcp` | Do not merge the `openmem` server |

**Provider resolution:** `MEMORY_PROVIDER` → `~/.config/hindsight/wizard.conf` → `hindsight`.

**Merge behavior:** Existing `hindsight`, `codegraph`, and `notebooklm` entries are preserved; mem0/Cognee entries are updated for the active provider.

## Portability tools

On the unified server, `memory_export` / `memory_import` speak **PMM** (Personal Memory Manifest). See [Portable memory (PMM)](memory-portability.md).

## Related

- [mem0](mem0.md) · [Cognee](cognee.md) · [Hindsight](hindsight.md)
- [Architecture](architecture.md) — how `memory_*` maps to provider HTTP
- [Quickstart](quickstart.md)
