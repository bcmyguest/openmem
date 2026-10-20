# Local Hindsight memory

Docker Compose setup for the local Hindsight coding-agent memory (the default **memory
provider**; see [docs/memory-providers.md](docs/memory-providers.md) for adding mem0 and others).
It runs three services:

- `litellm`: an OpenAI-compatible proxy (`ghcr.io/berriai/litellm:v1.105.1`) on the internal Docker network only. Hindsight sends every LLM call to it.
- `hindsight`: the Hindsight API on `127.0.0.1:8888` (`HINDSIGHT_PORT`), control plane on `127.0.0.1:9999` (`HINDSIGHT_CP_PORT`). Its database lives in the named volume `hindsight-data` (mounted at `/home/hindsight/.pg0`).
- `indexer`: indexes project repositories and Obsidian vaults into Hindsight and keeps them current.

## Does cloning just work?

Not without a few one-time steps: **SSH access** to this private repo, **Docker** (compose v2,
your user in the `docker` group), **Node 18+** for the interactive `./setup` UI, and a **model
backend** you configure in the wizard (lemond, Ollama, or an OpenAI-compatible server). There is
no cloud account in the loop unless you point custom routes at one. After `./setup` succeeds,
Hindsight listens on `http://127.0.0.1:8888` and the coding-agent plugin uses
`~/.hindsight/coding-agent.json` (linked from this repo).

## Prerequisites

- Docker with Compose v2.
- Node.js 18+ (all `./setup` paths; interactive runs use the Clack UI in `wizard/`).
- A model server behind the LiteLLM proxy:
  - lemond on this machine, `127.0.0.1:13305/v1` (containers reach it via `host.docker.internal`). It listens on all interfaces.
  - Or Ollama. Bind it to the Docker bridge gateway, not `0.0.0.0`: set `OLLAMA_HOST=172.17.0.1:11434` in its service environment (find the gateway with `docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}'`). `host.docker.internal` resolves to that address, so the litellm container reaches Ollama there, while the LAN cannot. Start Ollama after `docker.service` so the bridge exists. `OLLAMA_HOST=0.0.0.0:11434` also works but exposes Ollama to the LAN, which the unauthenticated API should not be.

## Quick start: `./setup`

`./setup` is a **Node** wizard (`wizard/bin/setup.mjs`): Clack asks **stack action** (configure /
start / stop — default is configure), **memory provider** (default from `wizard.conf` or
`hindsight`), then model backend and routes. Works on Linux and macOS. Non-interactive:
`./setup --yes`, `./setup --up --yes`, `./setup --down --yes`. Agent skills for providers live in
[.agents/skills/](.agents/skills/).

```sh
git clone git@github.com:bcmyguest/personal-memory.git
cd personal-memory
cp config/machine.env.example config/machine.env   # optional per-machine defaults
./setup
```

First interactive run installs `wizard/` npm deps automatically. `--yes` / `--dry-run` skip Clack
and need no `wizard/node_modules`.

**Mise-like config:** copy **`config/personal-memory.toml.example`** to
**`~/.config/personal-memory/config.toml`** — declarative provider, stack, model routing, and tasks.
See [docs/personal-memory-config.md](docs/personal-memory-config.md). Run **`./pm up`**, **`./pm down`**,
**`./pm doctor`** like mise tasks. Legacy **`config/machine.env`** still works. Ansible clones this repo and
calls `scripts/run-setup.sh`.

The wizard asks for:

1. Preflight: Docker with Compose v2, and free API and control-plane ports. A taken port offers the next free one.
2. Model backend (UI: pick **first**, then only that endpoint is queried): lemond, Ollama, or custom OpenAI-compatible (Meridian, hosted API). Reflect model can differ from retain/consolidate.
3. Secrets and env files under `~/.config/hindsight/` (mode 600), then `scripts/setup.sh`.
4. Source roots to index (default `~`, depth 3) and the Obsidian vaults it finds.
5. Optional NotebookLM sync (default no).
6. Start the stack, wait for health, and run a smoke retain and recall in a temporary bank.
7. Optional coding-agent config link and plugin install (default no).

Flags:

- `--yes`: accept every default without prompts.
- `--dry-run`: print the actions and run only read-only checks. Nothing is written and no containers start.
- `--no-smoke`: skip the smoke retain and recall. Use it for scripted re-runs.
- `--rebuild`: rebuild the indexer image even when its sources are unchanged.
- `PM_BACKEND=lemond|ollama|custom`: set the default backend choice (the wizard still asks unless `--yes`).
- `config/machine.env`: per-machine defaults for the wizard (`machine.env.example` in the repo).

The wizard builds the indexer image only when its inputs changed: its Dockerfile, `compose.yaml`, and every file its `COPY` lines read. The hash of those inputs lives in the git-ignored `.build-hash`. A rerun with no source change skips the build and starts the stack with `up -d --no-build`, so the containers are not recreated. Compose's own build cache does not decide this, because a cached build still yields a new image ID.

The last line is `wizard: changed=N`, the number of config files and containers the run altered. A rerun on an unchanged setup prints `changed=0`.

Rerun `./setup` at any time. It shows current values as defaults and keeps what you do not change.

Ports come from `HINDSIGHT_PORT` (default 8888) and `HINDSIGHT_CP_PORT` (default 9999), read from the environment or `.env`. The wizard writes the values it uses to `.env`. Compose binds them on `127.0.0.1` only.

HAL-Predictor bench runs need `compose.bench.yaml` as well. It also publishes Hindsight on the Docker bridge gateway `172.17.0.1:8888`, which sandboxes reach as `host.docker.internal:8888`. Loopback stays bound, and the bridge bind is not LAN-reachable. Apply it with:

```bash
docker compose -f compose.yaml -f compose.override.yaml -f compose.bench.yaml up -d hindsight
```

Keep `compose.override.yaml` in the `-f` list, because Compose skips it once `-f` is given. Without the bench file, the default `up -d` drops the bridge bind.

The manual steps below do the same work by hand.

## Manual setup

```sh
mkdir -p ~/.config/hindsight
cp config/hindsight.env.example ~/.config/hindsight/hindsight.env
chmod 600 ~/.config/hindsight/hindsight.env
node scripts/setup.mjs                       # required before the first compose command (bash wrapper ok)
node scripts/setup.mjs --migrate-env         # new hindsight.env: sets the LiteLLM key and aliases
docker compose up -d                        # needs COMPOSE_PROFILES=hindsight in .env (setup writes it)
curl -fsS http://127.0.0.1:8888/health   # or your HINDSIGHT_PORT
```

**Compose profiles:** `litellm` and `hindsight` use profile `hindsight`. Plain `docker compose up` without a profile starts only the indexer unless `.env` sets `COMPOSE_PROFILES=hindsight` (the setup wizard does). `./setup` passes `--profile hindsight` on compose commands. A `--profile` flag **replaces** `COMPOSE_PROFILES`, so name every profile you need on one command (for example `--profile hindsight --profile notebooklm`).

**Indexer sinks:** `bin/hindsight-project-index` talks to the memory API through `indexer/sinks/` (`--sink hindsight` default, or `MEMORY_SINK`). Use `MEMORY_API_URL` for non-Hindsight sinks; Hindsight keeps `HINDSIGHT_URL`.

`scripts/setup.sh` writes `HOST_UID`, `HOST_GID`, and `LITELLM_CONFIG` to `.env` (git-ignored, other lines kept), creates `~/.config/hindsight/litellm.env` if missing, then runs `scripts/gen-masks.sh`. Compose reads them for the indexer's user (`user: "${HOST_UID}:${HOST_GID}"`), so the indexer runs as your UID. Compose refuses to parse the project without `.env`, so run `setup.sh` before any `docker compose` command, including `docker compose logs` and `down`. Rerun it if your UID changes. The image needs no passwd entry for that UID; `HOME` comes from compose, and git trusts all repositories through the system gitconfig. The `hindsight` service needs no change: it uses the named volume `hindsight-data`.

The indexer mounts `$HOME` read-only. Its only writable path is the named volume `indexer-state`, mounted at `$HOME/.cache/hindsight-project-index` (`state.json` and its lock). The one-off `indexer-state-init` service runs as root, gives that volume to your UID, and exits before the indexer starts. Existing repositories' `.codegraph/` directories are left in place; delete them yourself if you no longer want them.

Moving from the previous read-write mount, seed the volume from the host state file once, so the switch does not re-retain every document:

```bash
docker compose stop indexer
docker compose run --rm --no-deps indexer-state-init   # creates the volume and gives it to your UID
docker run --rm --user "$HOST_UID:$HOST_GID" -v "$HOME/.cache/hindsight-project-index:/src:ro" \
  -v personal-memory_indexer-state:/dst personal-memory-indexer:local cp /src/state.json /dst/
```

Check the volume name with `docker volume ls` if the project name differs.

`scripts/gen-masks.sh` writes `compose.override.yaml` (git-ignored). It hides secret paths under `$HOME` from the indexer: `~/.ssh`, `~/.gnupg`, `~/.config/hindsight`, and others, plus the Codex and Claude credential files. Only paths that exist at generation time get a mask, so rerun the script when a new secret directory appears. Without the override, the indexer sees those paths. If `~/.config/hindsight/index.yml` exists, the override bind-mounts it to `/etc/hindsight/index.yml` and sets `HINDSIGHT_INDEX_CONFIG` to that path, because `~/.config/hindsight` is masked inside the container. Rerun `setup.sh` after creating or removing that file.

`compose.yaml` reads the env file from `$HINDSIGHT_ENV_FILE`, defaulting to `~/.config/hindsight/hindsight.env`. That file holds a secret and stays out of the repository; `.gitignore` lists it as a safety net.

## Model configuration

Hindsight never names a model server. It calls the LiteLLM proxy at `http://litellm:4000/v1` with three fixed aliases, and the proxy's YAML maps each alias to a model:

| Alias | Hindsight operation |
| --- | --- |
| `memory-retain` | retain (extraction on ingest) |
| `memory-reflect` | reflect, the base `HINDSIGHT_API_LLM_MODEL`, and mental-model refresh. Needs a model that makes tool calls |
| `memory-consolidate` | consolidation |

Shipped routes:

- `config/litellm.lemond.yaml`: `memory-reflect` is `openai/gemma-4-E4B-it-GGUF-Q4_K_M` (unsloth Q4_K_M, pulled into lemond); `memory-retain` and `memory-consolidate` stay on `openai/Gemma-4-E2B-it-GGUF` at `http://host.docker.internal:13305/v1` (lemond).
- `config/litellm.ollama.yaml` (optional, `MEMORY_BACKEND=ollama` only): `memory-reflect` is `ollama_chat/gemma4:e4b` at `http://host.docker.internal:11434` (Ollama); the other two aliases stay on `ollama_chat/gemma4:e2b`. The `gemma4:e4b` tag needs a newer Ollama than 0.20.3 (HTTP 412 on pull), so this route is not verified on this host.

Why reflect uses E4B: Gemma 4 E2B returned no usable tool call on Hindsight reflect (`finish_reason=length`). Measured on a three-fact test bank with the same query, through LiteLLM and lemond:

| Candidate | Direct tool call | Hindsight reflect |
| --- | --- | --- |
| `unsloth/gemma-4-E4B-it-GGUF:Q4_K_M` | pass, 6.5 s | HTTP 200, 29.1 s, grounded answer |
| `unsloth/Qwen3.5-4B-GGUF:Q4_K_M` | pass, 6.9 s | HTTP 200, 43.7 s, grounded answer |
| `NVIDIA-Nemotron-3.5-Bolt-74B-A9B-24GB` (already in lemond) | not run | lemond fails to load the GGUF: `blk.1.ffn_gate_inp.weight` shape mismatch, llama-server exits |

Qwen3.5-4B also passes, but Gemma E4B answers faster. The official `google/` org publishes no E4B GGUF, so the GGUF comes from `unsloth/`.

Planned: switch memory-reflect to Nemotron 3.5 Bolt E4B when released (Oct 23, 2026). No E4B repo exists yet on `nvidia/` or Ollama, so the alias stays on the candidates above.

Thinking is disabled on all three aliases (`memory-retain`, `memory-reflect`, `memory-consolidate`) in the route itself: `chat_template_kwargs.enable_thinking: false` on lemond, `think: false` on Ollama. These override the `reasoning_effort` that Hindsight sends per request (for example `HINDSIGHT_API_RETAIN_LLM_REASONING_EFFORT=low`), which a route default cannot. At `max_tokens` 200 a thinking reply can finish with empty content.

Output is capped at two levels. Each alias sets `max_tokens: 4096` and `timeout: 300` in its `litellm_params`. That value applies only when the client omits `max_tokens`; a client-sent larger value overrides it (tested: 8893 tokens generated against a 100000 request), so it is a default, not a ceiling. Hindsight enforces the real limit with `HINDSIGHT_API_{RETAIN,REFLECT,CONSOLIDATION}_MAX_COMPLETION_TOKENS` in `hindsight.env` (retain 16384, reflect and consolidation 2048). Retain must exceed every retain strategy's chunk size or Hindsight rejects the strategy: the default chunk is 3000, and the coding-agent plugin's strategies (`gitlog`, `git`, `conversation`, `document`) use `retain_chunk_size: 12000`, so a 4096 cap made plugin seeding fail with `400 Invalid retain strategy 'gitlog'`.

Selection, in order:

1. `~/.config/hindsight/litellm.yaml`, if it exists. A per-machine override that replaces the shipped routes entirely. It is mounted read-only into the proxy.
2. Otherwise `config/litellm.$MEMORY_BACKEND.yaml`, where `MEMORY_BACKEND` is `lemond` (default) or `ollama`.

The choice is written to `.env` as `LITELLM_CONFIG` when `scripts/setup.sh` runs. After changing `MEMORY_BACKEND`, an override file, or a route, rerun `setup.sh` and then `docker compose up -d litellm`. Optional Ollama route (not the default):

```sh
MEMORY_BACKEND=ollama bash scripts/setup.sh
docker compose up -d litellm
```

Secrets live in `~/.config/hindsight/litellm.env` (mode 600, created by `setup.sh`): `LITELLM_MASTER_KEY`, a random key that Hindsight also uses as its `HINDSIGHT_API_LLM_API_KEY`, and `LEMOND_API_KEY` (a placeholder; lemond ignores it). Routes read keys with `os.environ/NAME`, so the YAML holds no secrets.

Adding a hosted model: add the provider key to `litellm.env`, for example `ANTHROPIC_API_KEY=...`, then point an alias at it in the YAML:

```yaml
  - model_name: memory-reflect
    litellm_params:
      model: anthropic/claude-haiku-4-5
      api_key: os.environ/ANTHROPIC_API_KEY
```

Hindsight sends the same alias name for every provider, so changing a model never touches `hindsight.env`.

Verify a route from a throwaway container on the compose network, without publishing the proxy:

```sh
docker compose exec litellm python3 -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:4000/health/liveliness').read())"
```

### Migrating an existing `hindsight.env`

An older `hindsight.env` calls lemond or Ollama directly. Move it to the proxy once:

```sh
bash scripts/setup.sh --migrate-env   # backs up hindsight.env, rewrites only the LLM lines, prints no values
docker compose up -d                  # recreates hindsight so it reads the new env
```

The migration sets `HINDSIGHT_API_LLM_PROVIDER=openai`, `HINDSIGHT_API_LLM_BASE_URL=http://litellm:4000/v1`, the `*_LLM_MODEL` aliases, and `HINDSIGHT_API_LLM_API_KEY` to the LiteLLM master key. Other lines stay as they are. `setup.sh` prints a reminder when it finds a direct model URL.

To switch models or a route later, edit the LiteLLM YAML (or `litellm.yaml` override) and run `docker compose up -d litellm`. Hindsight needs no change.

## Coding-agent plugin (external)

The client plugin is installed separately, not by this repository:

```sh
npx @vectorize-io/hindsight-coding-agents install claude-code codex opencode
ln -s ~/personal-memory/config/coding-agent.json ~/.hindsight/coding-agent.json
```

`config/coding-agent.json` sets the plugin options (`optInPaths`, `mapPathToBank`, and related fields). Edit it for your machine before symlinking. The indexer reads the same file through the `$HOME` mount. If the file is missing, the indexer logs a warning and still indexes everything under `$HOME`.

## Indexing

The indexer indexes each source once at startup, then keeps it current:

- Obsidian vaults: any folder containing `.obsidian/` within a root's depth, plus `vaults.paths`. Each uses the bank `obsidian::<slug>` unless `banks` maps it. Changes are watched with inotify. A vault is re-indexed after `vault_quiet_seconds` (default 30) without changes. Dot-prefixed paths are ignored.
- Git repositories: the outermost repositories under each `roots` entry, plus `repos`. The indexer polls each one every `poll_seconds` (default 60). A poll fingerprints `HEAD` and the tracked-file status (`git status --porcelain -uno`). After one poll with an unchanged fingerprint, the repository is re-indexed. Edits to an already-modified tracked file change no fingerprint until `HEAD` or the status changes. Repositories with a persistent error re-run on each poll.
- Source discovery: sources are re-listed every `relist_seconds` (default 600), so new repositories and vaults are picked up without a restart.
- Code files get a tree-sitter outline (signatures, doc comments, imports) instead of a CodeGraph run. Parsing runs in-process; grammars are prefetched into the image at `/opt/tree-sitter-grammars`, so indexing needs no network. Supported languages: Python, JavaScript, TypeScript, TSX, Go, Rust, Java, C, C++, C#, Ruby, Lua, Bash, PHP. Known gaps: Go type declarations and TypeScript type aliases are not captured, and files with syntax errors give partial outlines. Outlines are re-retained once after this change, and the old CodeGraph-based code documents are deleted as stale.
- `optInPaths` filters sources. A missing file means no filter; an empty list means nothing is indexed.
- Automatic consolidation is disabled for the whole indexed bank, not only for indexed documents.
- Document IDs include the absolute source path. The first run after this change re-retains every document, which costs extraction time on the model server.
- Concurrent `--apply` runs (the watcher and a manual run) serialize through a lock on `state.json.lock`.

Set `INDEXER_DRY_RUN=1` to log the commands the watcher would run without executing them. The environment variables `POLL_SECONDS`, `VAULT_QUIET_SECONDS`, and `RELIST_SECONDS` override the timings in `index.yml`.

### Source config: `index.yml`

`config/index.yml` in the repository is the default. The indexer reads the first of these that exists:

1. `--config PATH` (manual runs and `--list`)
2. `$HINDSIGHT_INDEX_CONFIG`
3. `~/.config/hindsight/index.yml` (per machine; the container sees it through `scripts/setup.sh`'s mount)
4. `config/index.yml` (baked into the image at `/opt/config/index.yml`; rebuild after changing it)

A file found this way replaces the default entirely. Keys it omits take the built-in values, which match `config/index.yml`. Unknown keys and wrong types fail at startup with the file, key, and reason. `~` expands; a bare `~` in YAML is null, which means home under `roots[].path`.

| Key | Meaning |
| --- | --- |
| `roots` | `[{path, depth}]`. Repositories are the outermost git repositories found within `depth` levels (default 3). |
| `repos` | Extra repositories, outside the roots or not. Each must be a git repository. |
| `vaults.auto` | `true` (default) finds any folder with `.obsidian/` within a root's depth. |
| `vaults.paths` | Extra vault folders. |
| `exclude` | Glob patterns on absolute paths. A matching source is skipped. |
| `banks` | Absolute path prefix to bank id; the longest prefix wins. Applies to repos and vaults. Unmatched repos fall back to `~/.hindsight/coding-agent.json` `mapPathToBank`, then `coding-agent::<name>`. |
| `max_file_kb` | Largest indexed file, in kilobytes (1 KB = 1000 bytes). Default 128. |
| `skip_dirs` | Directory names not descended into. Dot-prefixed directories are always skipped. |
| `poll_seconds`, `vault_quiet_seconds`, `relist_seconds` | Watcher timings. |

`optInPaths` in `~/.hindsight/coding-agent.json` still filters sources after discovery.

Check the result with `--list` before a first `--apply`. Excluded sources are reported on stderr.

Manual runs. The script defaults to a dry run; `--apply` writes:

```sh
docker compose run --rm --no-deps indexer hindsight-project-index --list
docker compose run --rm --no-deps indexer hindsight-project-index --repo PATH --apply
docker compose run --rm --no-deps indexer hindsight-project-index --vault PATH --apply
```

`--no-deps` avoids starting the `hindsight` service, which the indexer depends on. `PATH` is the host path, which the container also sees.

## NotebookLM

Opt-in. Syncs notebooks, sources, notes, and (optionally) chats from Google NotebookLM into Hindsight banks named `notebooklm::<notebook slug>`. Each notebook gets one bank; duplicate titles get an ID suffix. The service runs only under the `notebooklm` compose profile, so `docker compose up` never starts it.

Risks:

- The default `client` backend uses the unofficial `notebooklm-py` library (pinned to 0.8.5). Google can change or block it at any time, and the sync then fails until the library is updated.
- The stored login is a Google session cookie set. Anyone who reads `~/.config/notebooklm` can act on that Google account. The directory is bind-mounted read-write into the sync container only, and masked from the indexer.
- Source text and notes are copied into the Hindsight banks on this machine, where Hindsight's model server processes them.

Login (on the host, once; re-run when Google expires the session). The commands below are not run by this repository:

```sh
mkdir -p ~/.config/notebooklm
uv tool install 'notebooklm-py[browser]==0.8.5'
uv tool run --from 'notebooklm-py[browser]==0.8.5' python -m playwright install chromium
NOTEBOOKLM_HOME=~/.config/notebooklm notebooklm login        # or: ... login --browser-cookies chrome
NOTEBOOKLM_HOME=~/.config/notebooklm notebooklm auth check --test --json
```

`login` opens a browser for the Google sign-in and saves `profiles/default/storage_state.json` under `NOTEBOOKLM_HOME`. `auth check --test` confirms the stored session works. The `playwright install` step is needed only if the login reports a missing browser; it is not run by this repository.

Enable and start:

1. Create `~/.config/hindsight/notebooklm.yml` with only the keys you change, for example:

   ```yaml
   enabled: true
   interval_minutes: 60        # default 60
   include_notebooks: ["Work*"] # fnmatch globs, case-insensitive; empty means all
   ```

   Compose refuses to start if this file is missing; create it first (`touch` is enough when there are no changes). Keys merge with `config/notebooklm.yml`; lists and scalars replace the shipped value.
2. Start the service from the repository:

   ```sh
   docker compose --profile notebooklm up -d notebooklm
   docker compose --profile notebooklm logs -f notebooklm
   ```

Without a login, the service logs the login commands and retries every 15 minutes. With `enabled: false` it sleeps and checks again hourly.

Enterprise backend (`backend: enterprise`): the documented NotebookLM Enterprise REST API lists recently viewed notebooks only. It returns no source or note text, so this backend syncs notebook metadata only. It is untested against a live Enterprise project.

## Logs

```sh
docker compose logs -f indexer
docker compose logs -f hindsight
```

## Stop and reset

```sh
docker compose down      # stop; keeps hindsight-data
docker compose down -v   # stop and delete the memory database
```
