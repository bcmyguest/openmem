# OpenMem

[![npm version](https://img.shields.io/npm/v/@bcmyguest/openmem.svg)](https://www.npmjs.com/package/@bcmyguest/openmem)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![openmem-mcp](https://glama.ai/mcp/servers/bcmyguest/openmem/badges/score.svg)](https://glama.ai/mcp/servers/bcmyguest/openmem/score)
[![GitHub](https://img.shields.io/badge/github-bcmyguest%2Fopenmem-blue)](https://github.com/bcmyguest/openmem)

[![openmem-mcp](https://glama.ai/mcp/servers/bcmyguest/openmem/badges/card.svg)](https://glama.ai/mcp/servers/bcmyguest/openmem)

**Docs:** [bcmyguest.github.io/openmem/](https://bcmyguest.github.io/openmem/) · **npm:** [@bcmyguest/openmem](https://www.npmjs.com/package/@bcmyguest/openmem) · **MCP:** `npx -y -p @bcmyguest/openmem openmem-mcp` (after the wizard — it needs a running provider) · **Repo:** [github.com/bcmyguest/openmem](https://github.com/bcmyguest/openmem)

**OpenMem** is a **memory interface for coding agents**: a stable `memory_*` API and ops surface over pluggable backends (Hindsight, mem0, Cognee, …), with shared wizard, indexer, and import/export formats (PMM first).

> Formerly **personal-memory**. Use the `openmem` CLI and MCP server name; installers drop the old `personal-memory` MCP entry.

**Start here:** [Concepts](https://bcmyguest.github.io/openmem/docs/concepts/) · [Quickstart](https://bcmyguest.github.io/openmem/docs/getting-started/) · [Compatibility](https://bcmyguest.github.io/openmem/docs/compatibility/)

## Quickstart

| Step | Command |
| --- | --- |
| 1. Wizard | `npx @bcmyguest/openmem` |
| 2. Check | `npx @bcmyguest/openmem doctor` |
| 3. Coding agents | `npx @bcmyguest/openmem install-coding-agent --yes` |

**Checkout instead of npx:**

```sh
git clone https://github.com/bcmyguest/openmem.git && cd openmem
npm install && npm run setup
```

Other commands from a checkout: `node cli/openmem.mjs <command>`.

**Needs:** Docker Compose v2, Node ≥ 20.12, and an LLM route if you use Hindsight (lemond, Ollama, OpenAI-compatible, or a Claude subscription through Meridian — set in the wizard).

Later: `npx @bcmyguest/openmem up` / `down` / `switch <provider> --yes` / `doctor`.

Wizard dry-run (what first setup plans — no writes):

![Setup dry-run: npx @bcmyguest/openmem setup --dry-run](https://bcmyguest.github.io/openmem/setup-demo.gif)

Full guide: [Quickstart](https://bcmyguest.github.io/openmem/docs/getting-started/) · [Concepts](https://bcmyguest.github.io/openmem/docs/concepts/) · [Architecture](https://bcmyguest.github.io/openmem/docs/architecture/)

## Architecture

```mermaid
flowchart TB
  subgraph disk["Sources on disk"]
    GIT[Git repos]
    OBS[Obsidian vaults]
    MD[notes · papers · bookmarks]
    FEED[Feed cache]
  end

  subgraph compose["Docker Compose — one active provider"]
    IDX[indexer]
    PROV[(Provider API)]
    IDX -->|retain / update| PROV
    LIT[LiteLLM]
    NLM[NotebookLM sync]
    LIT -.->|Hindsight stack + optional reflect synth| PROV
    NLM -.->|opt-in profile| PROV
  end

  LIT --> LLM[(lemond · Ollama · OpenAI-compatible)]

  subgraph host["Host — coding agents"]
    AG[Claude Code · Codex · Cursor Agent · OpenCode]
    UMCP["OpenMem MCP\n(memory_*)"]
    SHIM["Session hooks"]
    PLG["Hindsight plugin\n(optional, replaces hooks)"]
    SKILL["openmem skill"]
    PMCP[Provider MCP optional]
    NLMCP[NotebookLM MCP optional]
  end

  GIT --> IDX
  OBS --> IDX
  MD --> IDX
  FEED --> IDX
  AG <-->|stdio| UMCP
  AG <-->|hooks| SHIM
  AG --> SKILL
  AG <-->|optional| PLG
  SHIM --> UMCP
  AG <-->|stdio| PMCP
  AG <-->|stdio| NLMCP
  UMCP -->|loopback HTTP| PROV
  PLG -->|loopback HTTP| PROV
  PMCP -->|loopback HTTP| PROV
  NLMCP -->|loopback HTTP| PROV

  W["npx @bcmyguest/openmem\nsetup · install-mcp"] -.->|configure| compose
  W -.->|mcp.json| UMCP
```

| Connection | What it is |
| --- | --- |
| Sources → indexer → provider | Shared watcher; sink from active manifest (`MEMORY_SINK`) |
| Agents → MCP / hooks → provider | `install-coding-agent` installs the shared skill, unified `memory_*` MCP, and session hooks for Claude Code, Codex, Cursor Agent, and OpenCode. `[agents] integration` picks OpenMem hooks (default) or the Hindsight plugin (`--provider-plugin`) |
| Agents → context proxy → model API | Optional (`install-coding-agent --context-proxy`): trims long sessions, compresses tool results, and honours `/smart-compact` ([Context proxy](https://bcmyguest.github.io/openmem/docs/context-proxy/)) |
| Wizard (dashed) | Writes env, starts compose, registers MCP — not on the hot indexing path |

On Hindsight stacks, `memory_reflect` uses Hindsight's native reflect API and returns its answer with source evidence. On mem0 and Cognee, it searches first and uses the configured LiteLLM route for synthesis when available; otherwise it returns the search hits. See [Architecture](https://bcmyguest.github.io/openmem/docs/architecture/) for MCP and hooks limits.

## Providers and portability

- **Providers** — manifests under `providers/` ([Hindsight](https://bcmyguest.github.io/openmem/docs/hindsight/), [mem0](https://bcmyguest.github.io/openmem/docs/mem0/), [Cognee](https://bcmyguest.github.io/openmem/docs/cognee/)). Add another with a compose fragment, indexer sink, and wizard hooks.
- **MCP** — unified `memory_*` plus optional native/NotebookLM servers: [MCP setup](https://bcmyguest.github.io/openmem/docs/mcp-setup/).
- **Portable memory** — `memory_export` / `memory_import` speak **PMM**: [Portable memory](https://bcmyguest.github.io/openmem/docs/memory-portability/).
- **Switch** — `npx @bcmyguest/openmem switch <provider>` does not migrate data by itself; export/import (or re-index) moves content.

Default Hindsight compose: `litellm`, `hindsight` (`127.0.0.1:8888`), `indexer`. mem0/Cognee stacks omit LiteLLM unless you add them separately.

## Inspiration and related

OpenMem is not affiliated with these projects; they shape the problem or the pattern.

| | |
| --- | --- |
| **[OpenFeature](https://openfeature.dev/)** | Inspiration for a vendor-agnostic interface + pluggable providers (there: feature flags; here: coding-agent memory). |
| **[mise](https://mise.jdx.dev/) / [asdf](https://asdf-vm.com/)** | One CLI over many backends; declarative config and tasks without replacing each tool’s own settings. |
| **[Hindsight](https://github.com/vectorize-io/hindsight)** | Default memory provider in this repo. |
| **[mem0](https://github.com/mem0ai/mem0)** | Supported memory provider. |
| **[Cognee](https://github.com/topoteretes/cognee)** | Supported memory provider. |
| **[LiteLLM](https://github.com/BerriAI/litellm)** | Model proxy used on Hindsight stacks. |

More setup analogues (Chezmoi, Home Assistant integrations, …): [Provider status](https://bcmyguest.github.io/openmem/docs/provider-status/).

## License

[Apache License 2.0](LICENSE) — see `LICENSE` (Copyright 2026 B Guest).
