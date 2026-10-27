# Quickstart

Get from zero to a running stack in one wizard run. **Choose your memory provider** in the wizard (Hindsight by default; mem0 or Cognee if you prefer) — same CLI either way. Cloning the repo is optional; **`npx openmem`** is the usual path. For why OpenMem exists (interface layer, not a memory engine), see [Concepts](concepts.md).

## Before you start

| Requirement | Why |
| --- | --- |
| Docker + Compose v2 | Runs the stack; your user must run `docker` without sudo |
| Node.js ≥ 20.12 | CLI and setup wizard |
| LLM for Hindsight (default provider) | lemond, Ollama, or OpenAI-compatible — wizard wires LiteLLM |
| git, curl | Wizard preflight |

Default stack is [Hindsight](hindsight.md). Other providers: wizard or `npx openmem providers` ([provider status](provider-status.md)).

## 1. Run the wizard

**From npm (recommended):**

```sh
npx openmem
```

**From a git checkout** (repo directory is the stack root):

```sh
git clone https://github.com/bcmyguest/openmem.git
cd openmem
npm install
npx . setup
```

The wizard asks for a memory provider, provider settings, what to index, then starts Docker and runs a smoke test.

Useful variants:

```sh
npx openmem setup --dry-run     # plan only, no writes
npx openmem configure --yes       # defaults + start, no prompts
```

Wizard dry-run (what first setup plans — no writes):

![Setup dry-run: npx openmem setup --dry-run](https://bcmyguest.github.io/openmem/setup-demo.gif)

## 2. Confirm it is up

```sh
npx openmem doctor
curl -fsS http://127.0.0.1:8888/health   # Hindsight default; see wizard output for other providers
```

## 3. Wire your coding agent (optional)

**Session memory:** `npx openmem install-coding-agent --yes` — unified MCP **plus** session hooks for Claude Code, Codex, OpenCode, Cursor CLI (any active provider). Optional `--hindsight-plugin` adds the upstream Hindsight plugin. Not the same as `install-mcp` alone.

**`install-mcp`** merges the **`openmem` unified MCP** (`memory_add`, `memory_search`, `memory_recall`, `memory_reflect`, `memory_consolidate`, `memory_forget` on whichever provider you picked) and, when NotebookLM sync is on, the **NotebookLM MCP**:

```sh
npx openmem install-mcp --yes
npx openmem install-mcp --yes --notebooklm   # force NotebookLM entry
```

Session hooks use the in-repo shim by default; add `--hindsight-plugin` if you also want the upstream Hindsight plugin. Optional native mem0/Cognee MCP: `install-mcp --provider-only`. See [Architecture](architecture.md).

Restart Cursor Agent after MCP changes.

## Day-2

```sh
npx openmem up
npx openmem down
npx openmem switch mem0 --yes
npx openmem doctor
```

| Command | Purpose |
| --- | --- |
| `up` / `down` | Start or stop the stack (down keeps data volumes) |
| `switch <id> --yes` | Change provider (no memory migration) |
| `doctor` | Validate config without the smoke test |

In a checkout, use `npx .` instead of `npx openmem`.

## Where files live

| Install | Stack root (compose, `.env`) |
| --- | --- |
| `npx openmem` | `~/.local/share/personal-memory/stack` (override: `PM_STACK_ROOT`) |
| Git checkout | The clone directory |

Secrets and index config: `~/.config/hindsight/` (and optional `~/.config/personal-memory/config.toml`).

## Next

- [Architecture](architecture.md) — data flow, indexing, MCP by provider
- [Index sources](index-sources.md) — git, Obsidian, notes/papers/bookmarks, feed cache
- [Install with npx](npx-install.md) — upgrades, troubleshooting
- [Configuration file](openmem-config.md) — declarative `config.toml`
