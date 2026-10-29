# Quickstart

Get from zero to a running stack in one wizard run. **Choose your memory provider** in the wizard (Hindsight by default; mem0 or Cognee if you prefer) — same CLI either way. Cloning the repo is optional; **`npx @bcmyguest/openmem`** is the usual path. For why OpenMem exists (interface layer, not a memory engine), see [Concepts](concepts.md).

## Before you start

| Requirement | Why |
| --- | --- |
| Docker + Compose v2 | Runs the stack; your user must run `docker` without sudo |
| Node.js ≥ 20.12 | CLI and setup wizard |
| LLM for Hindsight (default provider) | lemond, Ollama, OpenAI-compatible, or a Claude subscription through [Meridian](meridian-litellm.md) — wizard wires LiteLLM |
| git, curl | Wizard preflight |

Default stack is [Hindsight](hindsight.md). Other providers: wizard or `npx @bcmyguest/openmem providers` ([provider status](provider-status.md)).

## 1. Run the wizard

**From npm (recommended):**

```sh
npx @bcmyguest/openmem
```

**From a git checkout** (repo directory is the stack root):

```sh
git clone https://github.com/bcmyguest/openmem.git
cd openmem
npm install
npm run setup
```

Run other commands from the checkout with `node cli/openmem.mjs <command>`.

The wizard asks for a memory provider, provider settings, what to index, then starts Docker and runs a smoke test.

Useful variants:

```sh
npx @bcmyguest/openmem setup --dry-run     # plan only, no writes
npx @bcmyguest/openmem configure --yes       # defaults + start, no prompts
```

Wizard dry-run (what first setup plans — no writes):

![Setup dry-run: npx @bcmyguest/openmem setup --dry-run](https://bcmyguest.github.io/openmem/setup-demo.gif)

## 2. Confirm it is up

```sh
npx @bcmyguest/openmem doctor
curl -fsS http://127.0.0.1:8888/health   # Hindsight default; see wizard output for other providers
```

## 3. Wire your coding agent (optional)

**Session memory** (after step 1 — MCP and hooks need the running stack): `npx @bcmyguest/openmem install-coding-agent --yes` — unified MCP **plus** session hooks for Claude Code, Codex, OpenCode, Cursor CLI (any active provider). On Hindsight, `--provider-plugin` uses the upstream Hindsight plugin hooks instead (one hook set at a time). Not the same as `install-mcp` alone.

**`install-mcp`** merges the **`openmem` unified MCP** (`memory_add`, `memory_search`, `memory_recall`, `memory_reflect`, `memory_consolidate`, `memory_forget` on whichever provider you picked) and, when NotebookLM sync is on, the **NotebookLM MCP**:

```sh
npx @bcmyguest/openmem install-mcp --yes
npx @bcmyguest/openmem install-mcp --yes --notebooklm   # force NotebookLM entry
```

Session hooks use the in-repo shim by default (`[agents] integration = "openmem"`); `--provider-plugin` replaces them with the upstream Hindsight plugin and `--no-provider-plugin` switches back. Optional native mem0/Cognee MCP: `install-mcp --provider-only`. Full guide: [MCP setup](mcp-setup.md).

Restart Cursor Agent after MCP changes. Move memories between providers with [Portable memory (PMM)](memory-portability.md) — `switch` alone does not migrate data.

## Day-2

```sh
npx @bcmyguest/openmem up
npx @bcmyguest/openmem down
npx @bcmyguest/openmem switch mem0 --yes
npx @bcmyguest/openmem doctor
```

| Command | Purpose |
| --- | --- |
| `up` / `down` | Start or stop the stack (down keeps data volumes) |
| `switch <id> --yes` | Change provider (no memory migration) |
| `doctor` | Validate config without the smoke test |
| `schedule install` | Refresh configured RSS/OpenAlex feeds hourly with the OS scheduler |

In a checkout, use `npx .` instead of `npx @bcmyguest/openmem`.

## Where files live

| Install | Stack root (compose, `.env`) |
| --- | --- |
| `npx @bcmyguest/openmem` | `~/.local/share/personal-memory/stack` (override: `PM_STACK_ROOT`) |
| Git checkout | The clone directory |

Secrets and index config: `~/.config/hindsight/` (and optional `~/.config/personal-memory/config.toml`).

## Next

- [MCP setup](mcp-setup.md) — unified `memory_*`, provider-native, NotebookLM
- [Portable memory (PMM)](memory-portability.md) — export/import
- [Architecture](architecture.md) — data flow, indexing, MCP by provider
- [Index sources](index-sources.md) — git, Obsidian, notes/papers/bookmarks, feed cache
- [Feed sync](sources-feeds.md) — configure RSS/OpenAlex and schedule refreshes
- [Install with npx](npx-install.md) — upgrades, troubleshooting
- [Configuration file](openmem-config.md) — declarative `config.toml`
