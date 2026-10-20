# Mise-like config (`config.toml`)

personal-memory is a **meta** orchestrator (see [memory-providers.md](memory-providers.md)). Its
declarative config is intentionally similar to **[mise](https://mise.jdx.dev/)**:

| mise | personal-memory |
| --- | --- |
| `~/.config/mise/config.toml` + `.mise.toml` | `~/.config/personal-memory/config.toml` + `personal-memory.toml` |
| `[tools]` plugins | `[memory] provider = "…"` + `providers/*/manifest.json` |
| `[env]` | Host ports / compose project under `[stack]` |
| `[tasks]` | `npx personal-memory up` / `down` / `doctor` / `install-mcp` / `switch` |
| `mise install` applies config | `npx personal-memory configure --yes` applies config |

We **do not** replace mise (or mem0/Hindsight native config). You can use both: mise installs
Node/Docker; this file describes **how agent memory runs on this machine**.

## Files

| Path | Purpose |
| --- | --- |
| `config/personal-memory.toml.example` | Shipped template; copy to your user config |
| `~/.config/personal-memory/config.toml` | **Primary** user config (gitignored on your machine) |
| `./personal-memory.toml` | Optional per-checkout overrides (e.g. different ports in a worktree) |
| `~/.config/hindsight/wizard.conf` | Last configure run (`MEMORY_PROVIDER`, ports, …); updated when setup applies |

## Precedence

1. CLI flags (`npx personal-memory setup --up`, `--down`, …)
2. Environment (`MEMORY_PROVIDER`, `PM_BACKEND`, `HINDSIGHT_PORT`, …)
3. `~/.config/personal-memory/config.toml`
4. `personal-memory.toml` / `config/personal-memory.toml` in the checkout stack root
5. Existing `wizard.conf` (provider, ports, model backend from the last wizard run)

Interactive `./setup` uses this file for **defaults** (Clack pre-selects); your answers still win.

## Sections

- **`[memory]`** — `provider` id (`hindsight`, future `mem0`, …).
- **`[stack]`** — compose project name and host ports.
- **`[wizard]`** — default action (`configure`, `up`, `down`).
- **`[model]`** — meta **LLM routing** for the Hindsight stack only; other providers add
  `[memory.<id>]` tables (see `[memory.mem0]` below).
- **`[memory.mem0]`** — the mem0 provider (URL-only: you run a mem0 REST server, this stack points
  the indexer at it). Never holds a key.

  ```toml
  [memory]
  provider = "mem0"

  [memory.mem0]
  api_url = "http://127.0.0.1:18888"        # the server as this host sees it
  # env_file = "~/.config/personal-memory/mem0.env"   # optional; where MEM0_API_KEY lives
  ```

  `api_url` is resolved as: `MEM0_API_URL`, then `PM_MEM0_API_URL`, then this table, then the stack
  `.env`, then `wizard.conf`, then the default `http://127.0.0.1:18888`. The indexer container
  gets the same URL with `127.0.0.1`/`localhost` rewritten to `host.docker.internal`
  (`MEM0_INDEXER_URL` in the stack `.env`). The API key is written by `./setup` (from
  `MEM0_API_KEY` under `--yes`, or a prompt) as the single line `MEM0_API_KEY=your-key-here` in the env file
  (`MEM0_ENV_FILE`, then `env_file`, then `~/.config/personal-memory/mem0.env`; mode 600 in a mode
  700 directory). You can also create that file by hand; a server run with `AUTH_DISABLED` needs
  none. The key never goes into the stack `.env`, `wizard.conf` or `config.toml`. A non-default
  `env_file` is exported to compose as `MEM0_ENV_FILE` for the run; export it yourself when you run
  `docker compose` by hand.
- **`[memory.cognee]`** — the Cognee provider (a pinned `cognee/cognee` container on a loopback
  port, single-user mode, no authentication). Never holds a key.

  ```toml
  [memory]
  provider = "cognee"

  [memory.cognee]
  port = 8766                                         # host port; the container listens on 8000
  env_file = "~/.config/personal-memory/cognee.env"   # where LLM_API_KEY lives
  ```

  `port` is resolved as: `COGNEE_PORT`, then this table, then the stack `.env`, then the port
  saved in `wizard.conf`, then the default `8766`. Both env file locations follow the same order:
  the variable (`COGNEE_ENV_FILE`, `COGNEE_INDEXER_ENV_FILE`), then `env_file` /
  `indexer_env_file` in this table, then the stack `.env`, then the defaults
  `~/.config/personal-memory/cognee.env` and `~/.config/personal-memory/cognee-indexer.env`.
  The second file is optional and is the one the indexer container reads; it holds only
  `COGNEE_API_KEY`. A non-default location (`~` is expanded, a relative path is taken relative
  to the stack root) is written to the stack `.env` as a path, so a plain `docker compose` finds
  the same files; the file contents never go there. Keep custom files inside
  `~/.config/personal-memory`: that is the directory hidden from the indexer's read-only `$HOME`
  mount, and setup warns about a file elsewhere under `$HOME`.

  Cognee builds its graph with an LLM, so documents are stored but not searchable until
  cognify can run. `./setup` writes settings into the env file (mode 600 in a mode 700
  directory), merging into any existing file and replacing only the keys it was given; it prints
  the path and the key names, never a value. Where the answers come from:

  | Variable (environment) | Written to the env file as |
  | --- | --- |
  | `PM_COGNEE_LLM_API_KEY`; under `--yes` or `--dry-run` also plain `LLM_API_KEY` | `LLM_API_KEY` |
  | `PM_COGNEE_LLM_PROVIDER`, `PM_COGNEE_LLM_MODEL`, `PM_COGNEE_LLM_ENDPOINT` | `LLM_PROVIDER`, `LLM_MODEL`, `LLM_ENDPOINT` |
  | `PM_COGNEE_EMBEDDING_PROVIDER`, `_MODEL`, `_ENDPOINT`, `_DIMENSIONS` | the same names without `PM_COGNEE_` |
  | `PM_COGNEE_EMBEDDING_API_KEY`; under `--yes` or `--dry-run` also plain `EMBEDDING_API_KEY` | `EMBEDDING_API_KEY` |
  | `PM_COGNEE_HUGGINGFACE_TOKENIZER` | `HUGGINGFACE_TOKENIZER` |

  **Local Ollama** (no cloud key): set `PM_COGNEE_LLM_PROVIDER=ollama` (and optionally
  `PM_COGNEE_LLM_MODEL=...`). The wizard fills in a complete local block when fields are missing:

  ```bash
  PM_COGNEE_LLM_PROVIDER=ollama PM_COGNEE_LLM_MODEL=llama3.2 ./setup --yes
  ```

  That writes (defaults only where unset):

  ```env
  LLM_PROVIDER=ollama
  LLM_API_KEY=replace-me
  LLM_ENDPOINT=http://host.docker.internal:11434
  EMBEDDING_PROVIDER=ollama
  EMBEDDING_MODEL=nomic-embed-text:latest
  EMBEDDING_ENDPOINT=http://host.docker.internal:11434/api/embed
  EMBEDDING_DIMENSIONS=768
  ```

  Use the bare Ollama host (`…:11434`), not `…:11434/v1` — Cognee's Ollama path appends
  `/api/generate` itself. **Host Ollama** (listening on the Docker bridge or all interfaces):
  `host.docker.internal` is correct. **Compose Ollama** published as `127.0.0.1:11434` only
  (this repo's default): that address is unreachable via `host.docker.internal` — set
  `PM_COGNEE_OLLAMA_COMPOSE=1` (or reuse `MEMORY_OLLAMA_IN_COMPOSE=1` from a Hindsight Ollama
  setup) so the wizard writes `http://ollama:11434`, and attach the Cognee container to the
  same Docker network as the `ollama` service. Slow local models may need
  `COGNEE_SKIP_CONNECTION_TEST=true` in `cognee.env`. The interactive setup offers OpenAI key
  vs Ollama; the OpenAI path uses a hidden prompt. Do not type the key into a non-Clack
  `./setup` prompt — put `LLM_API_KEY` in `cognee.env` (mode 600) by hand (Ollama accepts any
  non-empty value), or use the UI / `--yes` with `PM_COGNEE_LLM_API_KEY`. Secret variables
  (including plain `LLM_API_KEY` /
  `EMBEDDING_API_KEY` / `COGNEE_API_KEY`) are removed from the wizard's environment before it
  starts docker. With no cognify-ready config under `--yes` the wizard warns and carries on.
  Secrets never go into the stack `.env`, `wizard.conf`, `config.toml` or the summary.
  Authentication is off: `ENABLE_BACKEND_ACCESS_CONTROL` is pinned false in compose and
  overrides the env file (see `providers/cognee/compose.yaml`).
- **`[tasks.*]`** — descriptions for `npx personal-memory` / `./pm` (see `wizard/bin/pm.mjs` and
  `cli/personal-memory.mjs`). Built-in tasks:
  - `configure` / `up` / `down` / `doctor` — map to the setup wizard with the matching flags
  - `install-mcp` — runs `cli/install-memory-mcp.mjs` (merge memory MCP entries into
    `~/.cursor/mcp.json`)
  - `switch <provider>` — runs `cli/switch-memory-provider.mjs`: sets `MEMORY_PROVIDER` in
    `wizard.conf`, updates `[memory].provider` in `config.toml` when present
    (`updatePmConfigProvider`), optionally restarts the stack and re-points provider MCP.
    Flags: `--yes`, `--dry-run`, `--no-stack`, `--no-mcp`. Does not migrate data between
    backends. See [README — Switch memory provider](../README.md#switch-memory-provider).

## Apply

```bash
cp config/personal-memory.toml.example ~/.config/personal-memory/config.toml
# edit provider, ports, model backend
npx personal-memory configure --yes
# checkout before publish: npx . configure --yes
```

After a successful configure, the wizard **writes back** `~/.config/personal-memory/config.toml` so
the file matches what is running (mise-style source of truth).

## Doctor

```bash
npx personal-memory doctor
```

Runs the same checks as setup step “Validate memory setup” without mutating the stack.
