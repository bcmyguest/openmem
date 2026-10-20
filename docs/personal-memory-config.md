# Mise-like config (`config.toml`)

personal-memory is a **meta** orchestrator (see [memory-providers.md](memory-providers.md)). Its
declarative config is intentionally similar to **[mise](https://mise.jdx.dev/)**:

| mise | personal-memory |
| --- | --- |
| `~/.config/mise/config.toml` + `.mise.toml` | `~/.config/personal-memory/config.toml` + `personal-memory.toml` |
| `[tools]` plugins | `[memory] provider = "…"` + `providers/*/manifest.json` |
| `[env]` | Host ports / compose project under `[stack]` |
| `[tasks]` | `./pm up`, `./pm down`, `./pm doctor` |
| `mise install` applies config | `./setup --yes` applies config |

We **do not** replace mise (or mem0/Hindsight native config). You can use both: mise installs
Node/Docker; this file describes **how agent memory runs on this machine**.

## Files

| Path | Purpose |
| --- | --- |
| `config/personal-memory.toml.example` | Shipped template; copy to your user config |
| `~/.config/personal-memory/config.toml` | **Primary** user config (gitignored on your machine) |
| `./personal-memory.toml` | Optional per-checkout overrides (e.g. different ports in a worktree) |
| `config/machine.env` | Legacy env KEY=val seeds (still supported) |
| `~/.config/hindsight/wizard.conf` | Legacy KEY=val **mirror**; updated when setup applies |

## Precedence

1. CLI (`./setup --up`, `--down`, flags)
2. Environment (`MEMORY_PROVIDER`, `PM_BACKEND`, `HINDSIGHT_PORT`, …)
3. `~/.config/personal-memory/config.toml`
4. `personal-memory.toml` / `config/personal-memory.toml` in the repo
5. `config/machine.env`
6. Existing `wizard.conf`

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

  `port` is resolved as:   `COGNEE_PORT`, then this table, then (for `./pm up`) the port saved in `wizard.conf`, then the
  stack `.env`, then the default `8766`. The Cognee env file is `COGNEE_ENV_FILE`, then `env_file`, then
  `~/.config/personal-memory/cognee.env`; a non-default `env_file` is exported to compose as
  `COGNEE_ENV_FILE` for the run (export it yourself when you run `docker compose` by hand, and
  use an absolute path). The indexer container reads a second, optional file,
  `COGNEE_INDEXER_ENV_FILE` (default `~/.config/personal-memory/cognee-indexer.env`), which holds
  only `COGNEE_API_KEY`.

  Cognee builds its graph with an LLM, so documents are stored but not searchable until
  `LLM_API_KEY` works. `./setup` writes the key into the env file (mode 600 in a mode 700
  directory), merging into any existing file and replacing only the keys it was given; it prints
  the path and the key names, never a value. Where the answers come from:

  | Variable (environment) | Written to the env file as |
  | --- | --- |
  | `PM_COGNEE_LLM_API_KEY`; under `--yes` also plain `LLM_API_KEY` | `LLM_API_KEY` |
  | `PM_COGNEE_LLM_PROVIDER`, `PM_COGNEE_LLM_MODEL`, `PM_COGNEE_LLM_ENDPOINT` | `LLM_PROVIDER`, `LLM_MODEL`, `LLM_ENDPOINT` |
  | `PM_COGNEE_EMBEDDING_PROVIDER`, `_MODEL`, `_ENDPOINT`, `_API_KEY`, `_DIMENSIONS` | the same names without `PM_COGNEE_` |

  Only variables that are set are written, so a local model needs no key:
  `PM_COGNEE_LLM_PROVIDER=ollama PM_COGNEE_LLM_MODEL=... PM_COGNEE_LLM_ENDPOINT=http://host.docker.internal:11434/v1 ./setup --yes`
  (a model server on the host is `host.docker.internal` from the container). The interactive
  setup asks for the key with a hidden prompt. With no key under `--yes` the wizard warns and
  carries on. The key never goes into the stack `.env`, `wizard.conf`, `config.toml` or the
  summary. Authentication is off in this stack; to turn it on by hand, set
  `REQUIRE_AUTHENTICATION=true` in `cognee.env` and `COGNEE_API_KEY` in `cognee-indexer.env` (see
  the comments in `providers/cognee/compose.yaml`).
- **`[tasks.*]`** — descriptions for `./pm`; execution maps to `./setup` (see `wizard/bin/pm.mjs`).

## Apply

```bash
cp config/personal-memory.toml.example ~/.config/personal-memory/config.toml
# edit provider, ports, model backend
./setup --yes
```

After a successful configure, the wizard **writes back** `~/.config/personal-memory/config.toml` so
the file matches what is running (mise-style source of truth).

## Doctor

```bash
./pm doctor
```

Runs the same checks as setup step “Validate memory setup” without mutating the stack.
