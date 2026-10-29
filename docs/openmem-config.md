# Mise-like config (`config.toml`)

openmem is a **meta** orchestrator (see [architecture.md](architecture.md) on the site; [memory-providers.md](memory-providers.md) in the repo for contributors). Its
declarative config is intentionally similar to **[mise](https://mise.jdx.dev/)**:

| mise | openmem |
| --- | --- |
| `~/.config/mise/config.toml` + `.mise.toml` | `~/.config/personal-memory/config.toml` + `openmem.toml` |
| `[tools]` plugins | `[memory] provider = "…"` + `providers/*/manifest.json` |
| `[env]` | Host ports / compose project under `[stack]` |
| `[tasks]` | `npx @bcmyguest/openmem up` / `down` / `doctor` / `install-mcp` / `switch` |
| `mise install` applies config | `npx @bcmyguest/openmem configure --yes` applies config |

We **do not** replace mise (or mem0/Hindsight native config). You can use both: mise installs
Node/Docker; this file describes **how agent memory runs on this machine**.

## Files

| Path | Purpose |
| --- | --- |
| `config/openmem.toml.example` | Shipped template; copy to your user config |
| `~/.config/personal-memory/config.toml` | **Primary** user config (gitignored on your machine) |
| `./openmem.toml` | Optional per-checkout overrides (legacy `personal-memory.toml` still loads) |
| `~/.config/hindsight/wizard.conf` | Last configure run (`MEMORY_PROVIDER`, ports, …); updated when setup applies |

## Precedence

1. CLI flags (`npx @bcmyguest/openmem setup --up`, `--down`, …)
2. Environment (`MEMORY_PROVIDER`, `PM_BACKEND`, `HINDSIGHT_PORT`, …)
3. `~/.config/personal-memory/config.toml`
4. `openmem.toml` / `config/openmem.toml` in the checkout stack root (legacy `personal-memory.toml` names still load)
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
  env_file = "~/.config/personal-memory/cognee.env"   # cognify settings (GLiNER/FastEmbed by default)
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

  Documents are stored but not searchable until cognify can run. **Default cognify path** (no
  API key): local GLiNER extraction + FastEmbed embeddings. `./setup` / `--yes` with no LLM
  answers writes that block into the env file (mode 600 in a mode 700 directory), merging into
  any existing file and replacing only the keys it was given; it prints the path and the key
  names, never a value. Where the answers come from:

  | Variable (environment) | Written to the env file as |
  | --- | --- |
  | `PM_COGNEE_LLM_API_KEY`; under `--yes` or `--dry-run` also plain `LLM_API_KEY` | `LLM_API_KEY` |
  | `PM_COGNEE_LLM_PROVIDER`, `PM_COGNEE_LLM_MODEL`, `PM_COGNEE_LLM_ENDPOINT` | `LLM_PROVIDER`, `LLM_MODEL`, `LLM_ENDPOINT` |
  | `PM_COGNEE_EMBEDDING_PROVIDER`, `_MODEL`, `_ENDPOINT`, `_DIMENSIONS` | the same names without `PM_COGNEE_` |
  | `PM_COGNEE_EMBEDDING_API_KEY`; under `--yes` or `--dry-run` also plain `EMBEDDING_API_KEY` | `EMBEDDING_API_KEY` |
  | `PM_COGNEE_HUGGINGFACE_TOKENIZER` | `HUGGINGFACE_TOKENIZER` |
  | `PM_COGNEE_GRAPH_EXTRACTOR`, `PM_COGNEE_AUTO_FEEDBACK` | `GRAPH_EXTRACTOR`, `AUTO_FEEDBACK` |

  **Default (GLiNER + FastEmbed)** when no cognify answers are given:

  ```env
  GRAPH_EXTRACTOR=gliner_demo
  EMBEDDING_PROVIDER=fastembed
  EMBEDDING_MODEL=BAAI/bge-small-en-v1.5
  EMBEDDING_DIMENSIONS=384
  AUTO_FEEDBACK=false
  ```

  Compose pins `HF_HOME` / `FASTEMBED_CACHE_PATH` under the `cognee-data` volume so model
  downloads survive container recreates. Changing embedding dimensions requires rebuilding
  vectors (prune datasets or recreate the volume).

  **Local Ollama** (LLM + Ollama embeddings): set `PM_COGNEE_LLM_PROVIDER=ollama` (and optionally
  `PM_COGNEE_LLM_MODEL=...`). The wizard fills in a complete local block when fields are missing:

  ```bash
  PM_COGNEE_LLM_PROVIDER=ollama PM_COGNEE_LLM_MODEL=llama3.2 ./setup --yes
  ```

  That writes (defaults only where unset):

  ```env
  LLM_PROVIDER=ollama
  LLM_API_KEY=ollama
  LLM_ENDPOINT=http://host.docker.internal:11434
  EMBEDDING_PROVIDER=ollama
  EMBEDDING_MODEL=nomic-embed-text:latest
  EMBEDDING_ENDPOINT=http://host.docker.internal:11434/api/embed
  EMBEDDING_DIMENSIONS=768
  ```

  Ollama LLM + FastEmbed is also valid: set `PM_COGNEE_EMBEDDING_PROVIDER=fastembed` (and model /
  dimensions) alongside `PM_COGNEE_LLM_PROVIDER=ollama`. Use the bare Ollama host (`…:11434`),
  not `…:11434/v1` — Cognee's Ollama path appends `/api/generate` itself. **Host Ollama**
  (listening on the Docker bridge or all interfaces): `host.docker.internal` is correct.
  **Compose Ollama** published as `127.0.0.1:11434` only (this repo's default): that address is
  unreachable via `host.docker.internal` — set `PM_COGNEE_OLLAMA_COMPOSE=1` (or reuse
  `MEMORY_OLLAMA_IN_COMPOSE=1` from a Hindsight Ollama setup) so the wizard writes
  `http://ollama:11434`, and attach the Cognee container to the same Docker network as the
  `ollama` service. Slow local models may need `COGNEE_SKIP_CONNECTION_TEST=true` in
  `cognee.env`. The interactive setup offers GLiNER+FastEmbed (default), Ollama, or an OpenAI
  key (hidden prompt). Do not type the key into a non-Clack `./setup` prompt — put
  `LLM_API_KEY` in `cognee.env` (mode 600) by hand (Ollama accepts any non-empty value), or use
  the UI / `--yes` with `PM_COGNEE_LLM_API_KEY`. Secret variables (including plain `LLM_API_KEY` /
  `EMBEDDING_API_KEY` / `COGNEE_API_KEY`) are removed from the wizard's environment before it
  starts docker. Secrets never go into the stack `.env`, `wizard.conf`, `config.toml` or the
  summary. Authentication is off: `ENABLE_BACKEND_ACCESS_CONTROL` is pinned false in compose and
  overrides the env file (see `providers/cognee/compose.yaml`).
- **`[tasks.*]`** — descriptions for `npx @bcmyguest/openmem` / `./pm` (see `wizard/bin/pm.mjs` and
  `cli/openmem.mjs`). Built-in tasks:
  - `configure` / `up` / `down` / `doctor` — map to the setup wizard with the matching flags
  - `install-mcp` — runs `cli/install-memory-mcp.mjs` (NotebookLM MCP on Hindsight; mem0/Cognee
    with `--provider-only`; merges into `~/.cursor/mcp.json`)
  - `switch <provider>` — runs `cli/switch-memory-provider.mjs`: sets `MEMORY_PROVIDER` in
    `wizard.conf`, updates `[memory].provider` in `config.toml` when present
    (`updatePmConfigProvider`), optionally restarts the stack and re-points provider MCP.
    Flags: `--yes`, `--dry-run`, `--no-stack`, `--no-mcp`. Does not migrate data between
    backends. See [README — Switch memory provider](../README.md#switch-memory-provider).
  - `feed-sync` — runs `cli/feed-sync.mjs` (RSS + OpenAlex → `feeds.out_dir` in `index.yml`).
  - `install-coding-agent` — unified MCP + session hooks (all providers); `--provider-plugin` / `--no-provider-plugin` set `[agents] integration`; see
    [coding-agent hooks](coding-agent-hooks.md).

## MCP (unified `memory_*` tools)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PM_MEMORY_ADD_ASYNC` | `true` (implicit) | Hindsight `memory_add` sends `async: true` unless the tool passes `async: false`. Async ingest returns in ~200ms and avoids Cursor/Claude MCP `-32001` timeouts while extraction runs in the background. Set `PM_MEMORY_ADD_ASYNC=false` to force synchronous ingest. |

After changing MCP code, re-run `npx @bcmyguest/openmem install-coding-agent --yes` (or copy the repo into `~/.local/share/personal-memory/agent-runtime`) and **restart** the openmem MCP server in Cursor.

## Apply

```bash
cp config/openmem.toml.example ~/.config/personal-memory/config.toml
# edit provider, ports, model backend
npx @bcmyguest/openmem configure --yes
# from a checkout: node cli/openmem.mjs configure --yes
```

After a successful configure, the wizard **writes back** `~/.config/personal-memory/config.toml` so
the file matches what is running (mise-style source of truth).

## Doctor

```bash
npx @bcmyguest/openmem doctor
```

Runs the same checks as setup step “Validate memory setup” without mutating the stack.
