# Setup wizard

The wizard is a Node program (`wizard/bin/setup.mjs`). It is exposed as:

| How you run it | When |
| --- | --- |
| `npx @bcmyguest/openmem` / `npx @bcmyguest/openmem setup` | Normal install ([Install with npx](npx-install.md)) |
| `npx . setup` / `npm run setup` / `./setup` | Git checkout (stack root stays in the repo) |

Interactive runs use [@clack/prompts](https://github.com/bombshell-dev/clack). `--yes` and `--dry-run` skip Clack.

## Stack actions

Before provider questions, pick what the run should do (Clack or `PM_WIZARD_ACTION`):

| Action | Flag | Behavior |
| --- | --- | --- |
| Configure | default | Full wizard: provider, env, index sources, start stack, optional coding-agent step |
| Start | `--up` | Requires existing `~/.config/hindsight/wizard.conf`; starts stack and validates |
| Stop | `--down` | `docker compose down` for the project |

Non-interactive shortcuts:

```sh
npx @bcmyguest/openmem configure --yes   # setup --yes
npx @bcmyguest/openmem up                # wizard --up (after first configure)
npx @bcmyguest/openmem down              # wizard --down
```

## Wizard phases

Configure runs these steps in order (provider hooks replace or extend some steps):

| Step | Title | What happens |
| --- | --- | --- |
| 1 | Preflight | `git`, `curl`, `docker`, Compose v2; host UID/GID; API/control-plane ports |
| 2 | Memory provider | Hindsight, mem0, or Cognee ([Provider status](provider-status.md)) |
| 3 | Provider config | See table below |
| 4 | Secrets and env | Files under `~/.config/hindsight/` (mode 600); runs `scripts/setup.mjs` for stack `.env` and `compose.override.yaml` |
| 5 | Sources to index | Writes `~/.config/hindsight/index.yml`; lists sources with a dry indexer run |
| 6 | NotebookLM sync | Opt-in; Google login when enabled |
| 7 | Start the stack | Build indexer image if inputs changed; health wait; smoke retain/recall (unless `--no-smoke`) |
| 8 | Coding-agent plugin | Optional `npx` install for detected CLIs; provider-specific MCP hints |
| 9 | Validate memory setup | Provider checks + shared validation |

The last line is `wizard: changed=N` (files and containers this run touched). An unchanged re-run prints `changed=0`.

## Step 3 by provider

| Provider | Step 3 asks for |
| --- | --- |
| Hindsight | Model backend: lemond, Ollama (host or compose profile), or custom OpenAI-compatible URL; LiteLLM routes for `memory-retain`, `memory-reflect`, `memory-consolidate` |
| mem0 | Self-hosted REST base URL and API key file path |
| Cognee | Loopback port and `LLM_API_KEY` for graph build |

Details: [Model configuration](model-configuration.md) (Hindsight), `providers/mem0/OPERATOR.md`, `providers/cognee/OPERATOR.md`.

## Where configuration lives

| Path | Written by | Purpose |
| --- | --- | --- |
| Stack root `.env`, `.build-hash`, `compose.override.yaml` | `scripts/setup.mjs` | Compose project; indexer UID; secret-path masks |
| `~/.config/hindsight/wizard.conf` | Wizard | Provider id, backend choice, ports |
| `~/.config/hindsight/hindsight.env`, `litellm.env` | Setup / Hindsight hooks | Hindsight + LiteLLM secrets |
| `~/.config/hindsight/index.yml` | Wizard step 5 | Index roots, repos, vaults; optional `notes` / `papers` / `bookmarks` / `feeds` ([index-sources.md](index-sources.md)) |
| `~/.config/hindsight/notebooklm.yml` | Wizard step 6 | NotebookLM sync toggles |
| `~/.config/personal-memory/config.toml` | Optional; synced on configure | Declarative overrides ([Configuration file](openmem-config.md)) |
| `~/.hindsight/coding-agent.json` | Wizard / install-mcp | **Real file on disk** — do not symlink to the repo template |

### Stack root (npx installs)

When the CLI is not running from a git checkout, mutable compose files live under:

```text
${PM_STACK_ROOT:-${XDG_DATA_HOME:-~/.local/share}/personal-memory/stack}
```

Wizard code and provider hooks still run from the npm package. See [Install with npx](npx-install.md#stack-root).

## Wizard flags

| Flag | Effect |
| --- | --- |
| `--yes` / `-y` | Accept defaults; no prompts |
| `--dry-run` | Plan only; read-only checks; no writes or containers |
| `--no-smoke` | Skip retain/recall smoke test |
| `--rebuild` | Rebuild indexer image even if sources unchanged |
| `--up` / `--down` | Start or stop only (see stack actions) |

Environment (common):

| Variable | Meaning |
| --- | --- |
| `MEMORY_PROVIDER` | Default provider id |
| `PM_BACKEND` | Hindsight backend default (`lemond`, `ollama`, `custom`) |
| `PM_PROJECT` | Docker Compose project name |
| `PM_STACK_ROOT` / `PM_USE_CHECKOUT` | Stack root location |
| `HINDSIGHT_PORT`, `HINDSIGHT_CP_PORT` | Host API and control-plane ports |

Run `./setup --help` in a checkout for the full list.

## Indexer image builds

The wizard rebuilds the indexer image only when its inputs change (Dockerfile, `compose.yaml`, copied sources). The hash is stored in `.build-hash` at the stack root. If nothing changed, it uses `up -d --no-build` so containers are not recreated unnecessarily.

## Related docs

| Topic | Doc |
| --- | --- |
| npx, stack root, upgrades | [npx-install.md](npx-install.md) |
| `config.toml` and day-2 tasks | [openmem-config.md](openmem-config.md) |
| Manual compose without the wizard | [manual-stack-setup.md](manual-stack-setup.md) |
| LiteLLM routes and models | [model-configuration.md](model-configuration.md) |
| Index sources and `index.yml` | [indexing.md](indexing.md) |
| NotebookLM sync and MCP | [notebooklm.md](notebooklm.md) |
| Plugins and MCP install | [coding-agents.md](coding-agents.md) |
