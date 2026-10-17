# Local Hindsight memory

Docker Compose setup for the local Hindsight coding-agent memory. It runs two services:

- `hindsight`: the Hindsight API on `127.0.0.1:8888`, control plane on `127.0.0.1:9999`. Its database lives in the named volume `hindsight-data` (mounted at `/home/hindsight/.pg0`).
- `indexer`: indexes project repositories and Obsidian vaults into Hindsight and keeps them current.

## Prerequisites

- Docker with Compose v2.
- An OpenAI-compatible model server for extraction:
  - lemond on this machine, `127.0.0.1:13305/v1` (containers reach it via `host.docker.internal`). It listens on all interfaces.
  - Or Ollama. It must listen on all interfaces: set `OLLAMA_HOST=0.0.0.0:11434` in its service environment.

## Quick start

```sh
mkdir -p ~/.config/hindsight
cp config/hindsight.env.example ~/.config/hindsight/hindsight.env
chmod 600 ~/.config/hindsight/hindsight.env
$EDITOR ~/.config/hindsight/hindsight.env   # set HINDSIGHT_API_LLM_API_KEY and the model settings
bash scripts/setup.sh                       # required before the first compose command
docker compose up -d
curl -fsS http://127.0.0.1:8888/health
```

`scripts/setup.sh` writes `HOST_UID` and `HOST_GID` to `.env` (git-ignored, other lines kept), then runs `scripts/gen-masks.sh`. Compose reads them for the indexer's user (`user: "${HOST_UID}:${HOST_GID}"`), so the indexer runs as your UID and can write the `.codegraph/` directories it creates in your repositories. Compose refuses to parse the project without `.env`, so run `setup.sh` before any `docker compose` command, including `docker compose logs` and `down`. Rerun it if your UID changes. The image needs no passwd entry for that UID; `HOME` comes from compose, and git trusts all repositories through the system gitconfig. The `hindsight` service needs no change: it uses the named volume `hindsight-data`.

`scripts/gen-masks.sh` writes `compose.override.yaml` (git-ignored). It hides secret paths under `$HOME` from the indexer: `~/.ssh`, `~/.gnupg`, `~/.config/hindsight`, and others, plus the Codex and Claude credential files. Only paths that exist at generation time get a mask, so rerun the script when a new secret directory appears. Without the override, the indexer sees those paths. If `~/.config/hindsight/index.yml` exists, the override bind-mounts it to `/etc/hindsight/index.yml` and sets `HINDSIGHT_INDEX_CONFIG` to that path, because `~/.config/hindsight` is masked inside the container. Rerun `setup.sh` after creating or removing that file.

`compose.yaml` reads the env file from `$HINDSIGHT_ENV_FILE`, defaulting to `~/.config/hindsight/hindsight.env`. That file holds a secret and stays out of the repository; `.gitignore` lists it as a safety net.

To switch models, edit `HINDSIGHT_API_LLM_BASE_URL`, `HINDSIGHT_API_LLM_MODEL`, and `HINDSIGHT_API_LLM_API_KEY` in the env file, then run `docker compose up -d hindsight`. The default model is `Gemma-4-E2B-it-GGUF` served by lemond. The example includes a commented Ollama block (`qwen3.5:4b` at `http://host.docker.internal:11434/v1`).

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
