# Hindsight (default stack)

**Hindsight** is the default memory provider: Docker Compose runs **LiteLLM**, the **Hindsight API**, and the shared **indexer** on loopback. Retain, recall, reflect, and consolidate go through Hindsight’s HTTP API; LiteLLM routes model calls to lemond, Ollama, or another OpenAI-compatible backend.

Upstream project: [vectorize-io/hindsight](https://github.com/vectorize-io/hindsight).

## What openmem runs

| Service | Role |
| --- | --- |
| `litellm` | Proxy for Hindsight aliases `memory-retain`, `memory-reflect`, `memory-consolidate` |
| `hindsight` | Memory API (default host port **8888**, `HINDSIGHT_PORT`) |
| `indexer` | Git, Obsidian, markdown trees, feed cache → Hindsight banks via `MEMORY_SINK=hindsight` |

Health check after setup:

```sh
curl -fsS http://127.0.0.1:8888/health
```

Control plane URL is printed by the wizard (separate from the API port).

## Secrets and config (never in the repo)

| Path | Purpose |
| --- | --- |
| `~/.config/hindsight/hindsight.env` | Hindsight API settings |
| `~/.config/hindsight/litellm.yaml` | Optional full LiteLLM route override |
| `~/.config/hindsight/index.yml` | Index sources ([index-sources.md](index-sources.md)) |
| `~/.config/hindsight/wizard.conf` | Active provider and wizard choices |
| `~/.hindsight/coding-agent.json` | **Real file on disk** — repo maps, opt-in paths, NotebookLM access |

Shipped route templates live in `config/litellm.lemond.yaml` and `config/litellm.ollama.yaml`. Details: [Model configuration](model-configuration.md).

## Coding agents and MCP

**Default (all providers):** unified `memory_*` MCP plus in-repo session hooks:

```sh
npx @bcmyguest/openmem install-coding-agent --yes
```

**Optional:** use the upstream Hindsight plugin hooks instead of OpenMem’s. Hook sets are exclusive; the choice is saved as `[agents] integration = "provider"`, OpenMem’s hooks are removed, and the unified MCP stays:

```sh
npx @bcmyguest/openmem install-coding-agent --yes --provider-plugin
npx @bcmyguest/openmem install-coding-agent --yes --no-provider-plugin   # back to OpenMem hooks
```

`--hindsight-plugin` is a deprecated alias for `--provider-plugin`.

MCP without session hooks:

```sh
npx @bcmyguest/openmem install-mcp --yes
```

Restart Cursor Agent after MCP changes.

## Switch provider

```sh
npx @bcmyguest/openmem switch mem0 --yes
# return: npx @bcmyguest/openmem switch hindsight --yes
```

Updates compose profile, env, and MCP wiring. Does **not** migrate memories between backends.

## NotebookLM (opt-in)

NotebookLM sync and MCP are provider-agnostic but were built for Hindsight-first workflows. See [docs/notebooklm.md](notebooklm.md).

## See also

- [Architecture](architecture.md) — indexing and MCP paths
- [Model configuration](model-configuration.md) — LiteLLM aliases and backends
- [Provider status](provider-status.md)
