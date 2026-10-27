# OpenMem

[![npm version](https://img.shields.io/npm/v/openmem.svg)](https://www.npmjs.com/package/openmem)
[![GitHub](https://img.shields.io/badge/github-bcmyguest%2Fopenmem-blue)](https://github.com/bcmyguest/openmem)

**npm:** [openmem](https://www.npmjs.com/package/openmem) (alias: `personal-memory`) · **Repo:** [github.com/bcmyguest/openmem](https://github.com/bcmyguest/openmem)

**OpenMem** is an **interface layer** for coding-agent memory: plug in backends (Hindsight, mem0, Cognee, …), share one wizard and indexer, and move data across **import/export formats** (PMM is one of them). Switch providers without rewriting agent hooks.

> Formerly **personal-memory**. CLI binaries keep `personal-memory*` names as aliases.

## Quickstart

| Step | Command |
| --- | --- |
| 1. Wizard | `npx openmem` |
| 2. Check | `npx openmem doctor` |
| 3. Coding agents | `npx openmem install-coding-agent --yes` |

**Checkout instead of npx:**

```sh
git clone https://github.com/bcmyguest/openmem.git && cd openmem
npm install && npx . setup
```

**Needs:** Docker Compose v2, Node ≥ 20.12, and an LLM route if you use Hindsight (lemond, Ollama, or OpenAI-compatible — set in the wizard).

### Day-2

```sh
npx openmem up
npx openmem down
npx openmem switch mem0 --yes
npx openmem doctor
```

Wizard dry-run (what first setup plans — no writes):

![Setup dry-run: npx openmem setup --dry-run](https://bcmyguest.github.io/openmem/setup-demo.gif)

Full guide: [docs/quickstart.md](docs/quickstart.md) · [docs site](https://bcmyguest.github.io/openmem/docs/getting-started/) · [rebrand notes](docs/OPENMEM.md)

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
    PLG["Hindsight plugin\n(optional)"]
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

  W["npx openmem\nsetup · install-mcp"] -.->|configure| compose
  W -.->|mcp.json| UMCP
```

| Connection | What it is |
| --- | --- |
| Sources → indexer → provider | Shared watcher; sink from active manifest (`MEMORY_SINK`) |
| Agents → MCP / hooks → provider | `install-coding-agent` installs the shared skill, unified `memory_*` MCP, and session hooks for Claude Code, Codex, Cursor Agent, and OpenCode |
| Wizard (dashed) | Writes env, starts compose, registers MCP — not on the hot indexing path |

On Hindsight stacks, `memory_reflect` uses Hindsight's native reflect API and returns its answer with source evidence. On mem0 and Cognee, it searches first and uses the configured LiteLLM route for synthesis when available; otherwise it returns the search hits. See [coding-agent hooks](docs/coding-agent-hooks.md) for the current limits.

## Providers and portability

- **Providers** — manifests under `providers/` (Hindsight, mem0, Cognee). Add another with a compose fragment, indexer sink, and wizard hooks.
- **Formats** — `memory_export` / `memory_import` speak **PMM** today; more interchange formats belong in the same portability layer.
- **Switch** — `npx openmem switch <provider>` does not migrate data by itself; export/import (or re-index) moves content.

Default Hindsight compose: `litellm`, `hindsight` (`127.0.0.1:8888`), `indexer`. mem0/Cognee stacks omit LiteLLM unless you add them separately.

## License

Apache-2.0
