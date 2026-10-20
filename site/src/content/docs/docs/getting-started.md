---
title: "Getting started"
description: "Install personal-memory, run the setup wizard once, then use day-2 CLI tasks."
---

personal-memory wires coding agents to a **local memory provider** (Docker Compose + indexer). You run a wizard once; later you use `up`, `down`, and `doctor`.

**Provider support today:** see [Provider status](../provider-status/). Hindsight is supported; mem0 and Cognee are experimental.

## Requirements

| Requirement | Notes |
| --- | --- |
| Docker + Compose v2 | Your user must run `docker` without sudo |
| Node.js ≥ 20.12 | Wizard UI and CLI (`package.json` engines) |
| Model access (Hindsight) | lemond, Ollama, or any OpenAI-compatible server behind LiteLLM — configured in the wizard |
| curl, git | Checked in wizard preflight |

No cloud account unless you point a model route at one.

## Install and first run

| Path | Commands |
| --- | --- |
| **npm (recommended)** | `npx personal-memory` |
| **Git checkout** | `git clone https://github.com/bcmyguest/personal-memory.git && cd personal-memory && npm install && npx . setup` |

Useful first-run variants:

```sh
npx personal-memory setup --dry-run    # plan only
npx personal-memory configure --yes    # non-interactive defaults + start
npx personal-memory doctor               # validate without smoke
```

![Setup wizard dry-run](/personal-memory/setup-demo.gif)

After a successful configure, the Hindsight API is on `http://127.0.0.1:8888` by default (ports stored in stack `.env`). mem0 and Cognee use the ports their manifests define.

**Checkout vs npx:** a git clone uses the repo directory as the stack root. `npx personal-memory` copies compose files to `~/.local/share/personal-memory/stack` (overridable with `PM_STACK_ROOT`). See [Install with npx](../npx-install/).

## What the wizard does

Short version: pick a provider → provider-specific settings → write secrets and index config → start Docker → smoke test → optional coding-agent install.

Step-by-step tables, flags, and file paths: [Setup wizard](../setup-wizard/). Stack layout for npx: [Install with npx](../npx-install/#stack-root).

## Day-2 CLI

| Command | Purpose |
| --- | --- |
| `npx personal-memory up` | Start stack from saved config |
| `npx personal-memory down` | Stop stack (keeps DB volume) |
| `npx personal-memory doctor` | Config checks (no smoke) |
| `npx personal-memory install-mcp --yes` | Merge memory MCP entries into `~/.cursor/mcp.json` |
| `npx personal-memory switch <id> --yes` | Change provider (no memory migration) |
| `npx personal-memory providers` | List shipped providers |

In a checkout, prefix with `npx .` instead of `npx personal-memory`.

### install-mcp flags

| Flag | Effect |
| --- | --- |
| `--yes` | Write without prompting |
| `--provider-only` | Provider MCP only |
| `--notebooklm-only` | NotebookLM MCP only |
| `--dry-run` | Print planned merge |

Restart Cursor Agent after MCP or provider changes.

### switch flags

| Flag | Effect |
| --- | --- |
| `--no-stack` | Skip compose restart |
| `--no-mcp` | Skip provider MCP refresh |
| `--dry-run` | Plan only |

## Optional: NotebookLM for agents

When sync is enabled, agents can query `notebooklm::*` banks via MCP (`notebooklm_list_banks`, `notebooklm_search`). Prefer keyword search; LLM recall can be slow on CPU.

See [NotebookLM](../notebooklm/).

## Stop and reset

```sh
npx personal-memory down
docker compose down -v   # from stack root: delete memory database volume
```

## Next reads

| Topic | Page |
| --- | --- |
| npx stack root, upgrades, troubleshooting | [Install with npx](../npx-install/) |
| Wizard phases and flags | [Setup wizard](../setup-wizard/) |
| `config.toml` | [Configuration file](../personal-memory-config/) |
| Provider architecture | [Pluggable memory providers](../memory-providers/) |
