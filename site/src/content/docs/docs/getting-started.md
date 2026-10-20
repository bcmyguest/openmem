---
title: "Getting started"
description: "Prerequisites and install via npx (or a git checkout), plus MCP install and provider switch."
---

personal-memory sets up memory for coding agents on one machine. A wizard configures a memory provider, starts a Docker Compose stack, indexes your repositories and Obsidian vaults, and checks that the provider answers.

This page covers what works today. **Hindsight** is supported; **mem0** and **Cognee** are experimental (selectable in the wizard, not yet validated on every machine). For how each provider is wired, see [Provider status](../provider-status/).

## Prerequisites

- Docker with Compose v2, and your user allowed to run `docker`.
- Node.js 18 or newer. The interactive wizard uses the Clack UI.
- A model server for the provider you pick. For Hindsight, that is lemond, Ollama, or an OpenAI-compatible endpoint, which the wizard puts behind a LiteLLM proxy.

No cloud account is involved unless you point a model route at one.

## Install with npx

Preferred once the package is on the npm registry (see [Install with npx](../npx-install/)):

```sh
npx personal-memory                 # interactive setup
npx personal-memory setup --dry-run # plan only
npx personal-memory up
npx personal-memory doctor
```

Until the first publish, use a checkout and the same CLI shape via `npx .`:

```sh
git clone https://github.com/bcmyguest/personal-memory.git
cd personal-memory
npm install
npx . setup          # same as: npm run setup / ./setup
npx . setup --dry-run
```

![Setup wizard dry-run: preflight, provider choice, model backend, and stack plan](/personal-memory/setup-demo.gif)

## What the wizard asks

1. Preflight: Docker with Compose v2, and free API and control-plane ports. A taken port offers the next free one.
2. Stack action (configure, start, or stop) and memory provider (Hindsight, mem0, or Cognee).
3. Provider-specific steps: Hindsight asks for the model backend (lemond, Ollama, or a custom OpenAI-compatible server) and the route for each model alias; mem0 asks for your mem0 REST server URL and API key file; Cognee asks for a loopback port and `LLM_API_KEY` for graph build.
4. Secrets and env files under `~/.config/hindsight/` with mode 600.
5. Source roots to index and the Obsidian vaults it finds.
6. Whether to enable the opt-in NotebookLM sync (default no). When yes, it can also enable coding-agent access (`notebooklmAccess`) and register the NotebookLM MCP in `~/.cursor/mcp.json`.
7. Start the stack, wait for health, and run a smoke retain and recall in a temporary bank.
8. Whether to link the coding-agent config and install the plugin (default no). Provider MCP entries can be merged here or later with `npx personal-memory install-mcp`.

Rerun setup at any time (`npx personal-memory` / `npx . setup`). It shows current values as defaults and keeps what you do not change. The last line is `wizard: changed=N`, the number of config files and containers the run altered; a rerun on an unchanged setup prints `changed=0`.

Machine settings such as `optInPaths` and `notebooklmAccess` live in a **real** `~/.hindsight/coding-agent.json` (seeded from the shipped template). Do not symlink that path at the repo file, or pack checks and machine config will fight.

## Flags

| Flag | Effect |
| --- | --- |
| `--yes` | Accept every default without prompts. |
| `--dry-run` | Print the actions and run only read-only checks. |
| `--no-smoke` | Skip the smoke retain and recall. |
| `--rebuild` | Rebuild the indexer image even when its sources are unchanged. |
| `--up`, `--down` | Start or stop the stack without the configure steps. |

## Day-2 commands (`npx personal-memory …`)

Describe the setup in `~/.config/personal-memory/config.toml` if you want, then:

```sh
npx personal-memory up
npx personal-memory down
npx personal-memory doctor
npx personal-memory install-mcp --yes   # merge memory MCP into ~/.cursor/mcp.json
npx personal-memory switch mem0 --yes   # change MEMORY_PROVIDER (no data migration)
```

In a checkout before publish, the same subcommands work as `npx . up`, `npx . install-mcp --yes`, and so on. Checkout-only shortcuts `./pm …` and `npm run …` still exist.

See [Configuration file](../personal-memory-config/) for files, precedence, sections, and task flags (`--dry-run`, `--no-stack`, `--no-mcp`).

### Memory MCP (`install-mcp`)

```sh
npx personal-memory install-mcp --yes
# NotebookLM only:  npx personal-memory install-mcp --yes --notebooklm-only
# Provider MCP only: npx personal-memory install-mcp --yes --provider-only
```

Provider comes from `MEMORY_PROVIDER`, else `wizard.conf`, else `hindsight`. Restart Cursor Agent after install.

### Switch memory provider

```sh
npx personal-memory switch cognee --yes
```

Updates `wizard.conf` and `[memory].provider` in `config.toml` when present, restarts the stack unless `--no-stack`, and runs `install-mcp --provider-only` unless `--no-mcp`. Does **not** migrate memories. NotebookLM sync/MCP is left alone. After a switch: restart Cursor Agent, then `npx personal-memory doctor`.

## NotebookLM banks for agents

Synced notebooks land in `notebooklm::*` banks. With `notebooklmAccess.enabled: true`, the `notebooklm` MCP exposes:

| Tool | Purpose |
| --- | --- |
| `notebooklm_list_banks` | Allowlisted banks |
| `notebooklm_search` | Fast full-text search by default (`mode=list`); optional `mode=recall` for slow LLM synthesis |

Prefer short keyword queries. LLM recall can take tens of seconds on CPU and may hit MCP timeouts.

## Stop and reset

```sh
npx personal-memory down
# or from the stack / checkout compose project:
docker compose down      # stop; keeps the memory database
docker compose down -v   # stop and delete the memory database
```

## Next

- [Install with npx](../npx-install/): stack root, env vars, and the full command table.
- [Provider status](../provider-status/): what each provider is and how it self-hosts.
- [Pluggable memory providers](../memory-providers/): what the wizard owns and what a provider owns.
- [Configuration file](../personal-memory-config/): `config.toml` and tasks.
