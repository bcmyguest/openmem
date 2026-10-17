# Local Hindsight memory

Docker Compose setup for the local Hindsight coding-agent memory. It runs three services:

- `litellm`: an OpenAI-compatible proxy (`ghcr.io/berriai/litellm:v1.105.1`) on the internal Docker network only. Hindsight sends every LLM call to it.
- `hindsight`: the Hindsight API on `127.0.0.1:8888`, control plane on `127.0.0.1:9999`. Its database lives in the named volume `hindsight-data` (mounted at `/home/hindsight/.pg0`).
- `indexer`: indexes project repositories and Obsidian vaults into Hindsight and keeps them current.

## Prerequisites

- Docker with Compose v2.
- A model server behind the LiteLLM proxy:
  - lemond on this machine, `127.0.0.1:13305/v1` (containers reach it via `host.docker.internal`). It listens on all interfaces.
  - Or Ollama. It must listen on all interfaces: set `OLLAMA_HOST=0.0.0.0:11434` in its service environment.

## Quick start

```sh
mkdir -p ~/.config/hindsight
cp config/hindsight.env.example ~/.config/hindsight/hindsight.env
chmod 600 ~/.config/hindsight/hindsight.env
bash scripts/setup.sh                       # required before the first compose command
bash scripts/setup.sh --migrate-env         # new hindsight.env: sets the LiteLLM key and aliases
docker compose up -d                        # starts litellm, then hindsight and indexer
curl -fsS http://127.0.0.1:8888/health
```

`scripts/setup.sh` writes `HOST_UID`, `HOST_GID`, and `LITELLM_CONFIG` to `.env` (git-ignored, other lines kept), creates `~/.config/hindsight/litellm.env` if missing, then runs `scripts/gen-masks.sh`. Compose reads them for the indexer's user (`user: "${HOST_UID}:${HOST_GID}"`), so the indexer runs as your UID and can write the `.codegraph/` directories it creates in your repositories. Compose refuses to parse the project without `.env`, so run `setup.sh` before any `docker compose` command, including `docker compose logs` and `down`. Rerun it if your UID changes. The image needs no passwd entry for that UID; `HOME` comes from compose, and git trusts all repositories through the system gitconfig. The `hindsight` service needs no change: it uses the named volume `hindsight-data`.

`scripts/gen-masks.sh` writes `compose.override.yaml` (git-ignored). It hides secret paths under `$HOME` from the indexer: `~/.ssh`, `~/.gnupg`, `~/.config/hindsight`, and others, plus the Codex and Claude credential files. Only paths that exist at generation time get a mask, so rerun the script when a new secret directory appears. Without the override, the indexer sees those paths. If `~/.config/hindsight/index.yml` exists, the override bind-mounts it to `/etc/hindsight/index.yml` and sets `HINDSIGHT_INDEX_CONFIG` to that path, because `~/.config/hindsight` is masked inside the container. Rerun `setup.sh` after creating or removing that file.

`compose.yaml` reads the env file from `$HINDSIGHT_ENV_FILE`, defaulting to `~/.config/hindsight/hindsight.env`. That file holds a secret and stays out of the repository; `.gitignore` lists it as a safety net.

## Model configuration

Hindsight never names a model server. It calls the LiteLLM proxy at `http://litellm:4000/v1` with three fixed aliases, and the proxy's YAML maps each alias to a model:

| Alias | Hindsight operation |
| --- | --- |
| `memory-retain` | retain (extraction on ingest) |
| `memory-reflect` | reflect, the base `HINDSIGHT_API_LLM_MODEL`, and mental-model refresh |
| `memory-consolidate` | consolidation |

Shipped routes, all Gemma 4 E2B:

- `config/litellm.lemond.yaml`: `openai/Gemma-4-E2B-it-GGUF` at `http://host.docker.internal:13305/v1` (lemond).
- `config/litellm.ollama.yaml`: `ollama_chat/gemma4:e2b` at `http://host.docker.internal:11434` (Ollama).

`memory-retain` turns Gemma's thinking off in the route itself: `chat_template_kwargs.enable_thinking: false` on lemond, `think: false` on Ollama. These override the `reasoning_effort` that Hindsight sends per request (for example `HINDSIGHT_API_RETAIN_LLM_REASONING_EFFORT=low`), which a route default cannot. The other aliases keep the model's default thinking. At `max_tokens` 200 a thinking reply can finish with empty content, so check reflect and consolidate before relying on them.

Selection, in order:

1. `~/.config/hindsight/litellm.yaml`, if it exists. A per-machine override that replaces the shipped routes entirely. It is mounted read-only into the proxy.
2. Otherwise `config/litellm.$MEMORY_BACKEND.yaml`, where `MEMORY_BACKEND` is `lemond` (default) or `ollama`.

The choice is written to `.env` as `LITELLM_CONFIG` when `scripts/setup.sh` runs. After changing `MEMORY_BACKEND`, an override file, or a route, rerun `setup.sh` and then `docker compose up -d litellm`. For a laptop on Ollama:

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

`config/coding-agent.json` sets the plugin options, including `optInPaths` (`/home/example`). The indexer reads the same file through the `$HOME` mount. If the file is missing, the indexer logs a warning and still indexes everything under `$HOME`.

## Indexing

The indexer indexes each source once at startup, then keeps it current:

- Obsidian vaults: any folder containing `.obsidian/` within a root's depth, plus `vaults.paths`. Each uses the bank `obsidian::<slug>` unless `banks` maps it. Changes are watched with inotify. A vault is re-indexed after `vault_quiet_seconds` (default 30) without changes. Dot-prefixed paths are ignored.
- Git repositories: the outermost repositories under each `roots` entry, plus `repos`. The indexer polls each one every `poll_seconds` (default 60). A poll fingerprints `HEAD` and the tracked-file status (`git status --porcelain -uno`). After one poll with an unchanged fingerprint, the repository is re-indexed. Edits to an already-modified tracked file change no fingerprint until `HEAD` or the status changes. Repositories with a persistent error re-run on each poll.
- Source discovery: sources are re-listed every `relist_seconds` (default 600), so new repositories and vaults are picked up without a restart.
- Repositories also get CodeGraph runs, which create `.codegraph/` directories.
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
