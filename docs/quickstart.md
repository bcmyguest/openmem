# Quickstart

Get from zero to a running stack in one wizard run. **Choose your memory provider** in the wizard (Hindsight by default; mem0 or Cognee if you prefer) — same CLI either way. Cloning the repo is optional; **`npx personal-memory`** is the usual path.

## Before you start

| Requirement | Why |
| --- | --- |
| Docker + Compose v2 | Runs the stack; your user must run `docker` without sudo |
| Node.js ≥ 20.12 | CLI and setup wizard |
| LLM for Hindsight (default provider) | lemond, Ollama, or OpenAI-compatible — wizard wires LiteLLM |
| git, curl | Wizard preflight |

If you are not using Hindsight, pick a provider in the wizard or run `npx personal-memory providers` first ([provider status](https://bcmyguest.github.io/personal-memory/docs/provider-status/)).

## 1. Run the wizard

**From npm (recommended):**

```sh
npx personal-memory
```

**From a git checkout** (repo directory is the stack root):

```sh
git clone https://github.com/bcmyguest/personal-memory.git
cd personal-memory
npm install
npx . setup
```

The wizard asks for a memory provider, provider settings, what to index, then starts Docker and runs a smoke test.

Useful variants:

```sh
npx personal-memory setup --dry-run     # plan only, no writes
npx personal-memory configure --yes       # defaults + start, no prompts
```

![Wizard dry-run](https://bcmyguest.github.io/personal-memory/setup-demo.gif)

## 2. Confirm it is up

```sh
npx personal-memory doctor
curl -fsS http://127.0.0.1:8888/health   # Hindsight default; see wizard output for other providers
```

## 3. Wire your coding agent (optional)

**Hindsight session memory** uses the [`@vectorize-io/hindsight-coding-agents`](https://www.npmjs.com/package/@vectorize-io/hindsight-coding-agents) plugin from the wizard — not `install-mcp`.

**`install-mcp`** merges the **`personal-memory` unified MCP** (`memory_add`, `memory_search`, `memory_recall`, `memory_forget` on whichever provider you picked) and, when NotebookLM sync is on, the **NotebookLM MCP**:

```sh
npx personal-memory install-mcp --yes
npx personal-memory install-mcp --yes --notebooklm   # force NotebookLM entry
```

Hindsight **in-editor** session memory still uses the coding-agent **plugin** from the wizard. Optional native mem0/Cognee MCP: `--provider-only`. See [Architecture](architecture.md).

Restart Cursor Agent after MCP changes.

## Day-2

| Command | Purpose |
| --- | --- |
| `npx personal-memory up` | Start stack |
| `npx personal-memory down` | Stop stack (keeps data volume) |
| `npx personal-memory switch <id> --yes` | Change provider (no memory migration) |

In a checkout, use `npx .` instead of `npx personal-memory`.

## Where files live

| Install | Stack root (compose, `.env`) |
| --- | --- |
| `npx personal-memory` | `~/.local/share/personal-memory/stack` (override: `PM_STACK_ROOT`) |
| Git checkout | The clone directory |

Secrets and index config: `~/.config/hindsight/` (and optional `~/.config/personal-memory/config.toml`).

## Next

- [Architecture](architecture.md) — data flow, indexing, MCP by provider
- [Install with npx](npx-install.md) — upgrades, troubleshooting
- [Configuration file](personal-memory-config.md) — declarative `config.toml`
