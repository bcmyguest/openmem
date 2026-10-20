---
title: "Getting started"
description: "Prerequisites and the from-source install that works today, plus the planned npx path."
---

personal-memory sets up memory for coding agents on one machine. A wizard configures a memory provider, starts a Docker Compose stack, indexes your repositories and Obsidian vaults, and checks that the provider answers.

This page covers what works today. For how each provider is wired, see [Provider status](../provider-status/).

## Prerequisites

- Docker with Compose v2, and your user allowed to run `docker`.
- Node.js 18 or newer. The interactive wizard uses the Clack UI.
- A model server for the provider you pick. For Hindsight, that is lemond, Ollama, or an OpenAI-compatible endpoint, which the wizard puts behind a LiteLLM proxy.

No cloud account is involved unless you point a model route at one.

## Install from source

This is the path that works today.

```sh
git clone https://github.com/bcmyguest/personal-memory.git
cd personal-memory
./setup
```

The first interactive run installs the wizard's npm dependencies. To see what the wizard would do first, run it with `--dry-run`: it prints the actions and runs only read-only checks, writes nothing, and starts no containers.

```sh
./setup --dry-run
```

## Install with npx

:::caution[Not published yet]
`npx personal-memory` is planned and is available after the first npm release. Until then, use the from-source path above.
:::

## What the wizard asks

1. Preflight: Docker with Compose v2, and free API and control-plane ports. A taken port offers the next free one.
2. Stack action (configure, start, or stop) and memory provider.
3. For Hindsight: the model backend (lemond, Ollama, or a custom OpenAI-compatible server) and the route for each model alias.
4. Secrets and env files under `~/.config/hindsight/` with mode 600.
5. Source roots to index and the Obsidian vaults it finds.
6. Whether to enable the opt-in NotebookLM sync (default no).
7. Start the stack, wait for health, and run a smoke retain and recall in a temporary bank.
8. Whether to link the coding-agent config and install the plugin (default no).

Rerun `./setup` at any time. It shows current values as defaults and keeps what you do not change. The last line is `wizard: changed=N`, the number of config files and containers the run altered; a rerun on an unchanged setup prints `changed=0`.

## Flags

| Flag | Effect |
| --- | --- |
| `--yes` | Accept every default without prompts. |
| `--dry-run` | Print the actions and run only read-only checks. |
| `--no-smoke` | Skip the smoke retain and recall. |
| `--rebuild` | Rebuild the indexer image even when its sources are unchanged. |
| `--up`, `--down` | Start or stop the stack without the configure steps. |

## Declarative config

Instead of answering prompts, describe the setup in `~/.config/personal-memory/config.toml` and run the tasks:

```sh
./pm up
./pm down
./pm doctor
```

See [Configuration file](../personal-memory-config/) for the files, precedence, and sections.

## Stop and reset

```sh
docker compose down      # stop; keeps the memory database
docker compose down -v   # stop and delete the memory database
```

## Next

- [Provider status](../provider-status/): what each provider is and how it self-hosts.
- [Pluggable memory providers](../memory-providers/): what the wizard owns and what a provider owns.
- [Provider wizard hooks](../provider-wizard-hooks/): the phase order and the hook contract.
