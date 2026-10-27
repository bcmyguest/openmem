# personal-memory

[![npm version](https://img.shields.io/npm/v/personal-memory.svg)](https://www.npmjs.com/package/personal-memory)

**npm:** [personal-memory](https://www.npmjs.com/package/personal-memory) · **Docs:** [bcmyguest.github.io/personal-memory](https://bcmyguest.github.io/personal-memory/)

**Pick your memory backend** — Hindsight, mem0, or Cognee (all supported today), or the next manifest. One wizard and indexer on your machine; switch with `npx personal-memory switch`. Architecture: [docs/architecture.md](docs/architecture.md) · contributors: [memory providers](docs/memory-providers.md).

## Quickstart

| Step | Command |
| --- | --- |
| 1. Wizard | `npx personal-memory` |
| 2. Check | `npx personal-memory doctor` |
| 3. Coding agents | `npx personal-memory install-coding-agent --yes` |

**Checkout instead of npx:**

```sh
git clone https://github.com/bcmyguest/personal-memory.git && cd personal-memory
npm install && npx . setup
```

**Needs:** Docker Compose v2, Node ≥ 20.12, and an LLM route if you use Hindsight (lemond, Ollama, or OpenAI-compatible — set in the wizard).

### Day-2

```sh
npx personal-memory up
npx personal-memory down
npx personal-memory switch mem0 --yes
npx personal-memory doctor
```

Wizard dry-run (what first setup plans — no writes):

![Setup dry-run: npx personal-memory setup --dry-run](https://bcmyguest.github.io/personal-memory/setup-demo.gif)

Full guide: [docs/quickstart.md](docs/quickstart.md) · [docs site](https://bcmyguest.github.io/personal-memory/docs/getting-started/)

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
    UMCP["personal-memory MCP\n(memory_*)"]
    SHIM["Session hooks"]
    PLG["Hindsight plugin\n(optional)"]
    SKILL["personal-memory skill"]
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

  W["npx personal-memory\nsetup · install-mcp"] -.->|configure| compose
  W -.->|mcp.json| UMCP
```

| Connection | What it is |
| --- | --- |
| Sources → indexer → provider | Shared watcher; sink from active manifest (`MEMORY_SINK`) |
| Agents → MCP / hooks → provider | `install-coding-agent` installs the shared **`personal-memory`** skill, unified `memory_*` MCP, and session hooks for Claude Code, Codex, Cursor Agent, and OpenCode |
| Wizard (dashed) | Writes env, starts compose, registers MCP — not on the hot indexing path |

On Hindsight stacks, `memory_reflect` uses Hindsight's native reflect API and returns its answer with source evidence. On mem0 and Cognee, it searches first and uses the configured LiteLLM route for synthesis when available; otherwise it returns the search hits. See [coding-agent hooks](docs/coding-agent-hooks.md) for the current limits.

Re-run `npx personal-memory install-coding-agent --yes` after updating the hook code. Claude Code and the other installed agents run a copy in `~/.local/share/personal-memory/agent-runtime`; an older copy can resolve a different, case-sensitive project bank than the indexer.
On Hindsight, Stop hooks queue transcript extraction and checkpoint after Hindsight accepts the operation. MCP `memory_add` defaults to async; pass `async: false` to block until extraction finishes. Check Hindsight operations for a queued extraction that later fails.
SessionStart hooks use bounded recall rather than model-backed reflect. On Hindsight they request the low retrieval budget and at most 1200 fact tokens; hook context is capped at 8000 characters.

Default Hindsight compose: `litellm`, `hindsight` (`127.0.0.1:8888`), `indexer`. mem0/Cognee stacks omit LiteLLM unless you add them separately.

Full detail: [docs/architecture.md](docs/architecture.md).

## Documentation

| Topic | File |
| --- | --- |
| Quickstart | [docs/quickstart.md](docs/quickstart.md) |
| Setup wizard | [docs/setup-wizard.md](docs/setup-wizard.md) |
| npx install, stack root | [docs/npx-install.md](docs/npx-install.md) |
| `config.toml` | [docs/personal-memory-config.md](docs/personal-memory-config.md) |
| Manual compose | [docs/manual-stack-setup.md](docs/manual-stack-setup.md) |
| Models (LiteLLM) | [docs/model-configuration.md](docs/model-configuration.md) |
| Indexing | [docs/indexing.md](docs/indexing.md) |
| NotebookLM | [docs/notebooklm.md](docs/notebooklm.md) |
| Coding agents / MCP | [docs/coding-agents.md](docs/coding-agents.md) |

## Logs and reset

```sh
npx personal-memory down
docker compose down -v   # from stack root: delete the memory database volume
docker compose logs -f indexer hindsight
```
