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
bash scripts/gen-masks.sh                   # required before the first start
docker compose up -d
curl -fsS http://127.0.0.1:8888/health
```

`scripts/gen-masks.sh` writes `compose.override.yaml` (git-ignored). It hides secret paths under `$HOME` from the indexer: `~/.ssh`, `~/.gnupg`, `~/.config/hindsight`, and others, plus the Codex and Claude credential files. Only paths that exist at generation time get a mask, so rerun the script when a new secret directory appears. Without the override, the indexer sees those paths.

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

- Obsidian vaults: `~/Documents/Personal`, `~/Documents/Work`, and `~/Documents/Acme Notes`. Each uses the bank `obsidian::<slug>`. Changes are watched with inotify. A vault is re-indexed after 30 seconds without changes. Dot-prefixed paths are ignored.
- Git repositories: discovered under `$HOME`. The indexer polls each one every `POLL_SECONDS` (default 60). A poll fingerprints `HEAD` and the tracked-file status (`git status --porcelain -uno`). After one poll with an unchanged fingerprint, the repository is re-indexed. Edits to an already-modified tracked file change no fingerprint until `HEAD` or the status changes. Repositories with a persistent error re-run on each poll.
- Source discovery: sources are re-listed every 600 seconds, so new repositories and vaults are picked up without a restart.
- Repositories also get CodeGraph runs, which create `.codegraph/` directories.
- `optInPaths` filters sources. A missing file means no filter; an empty list means nothing is indexed.
- Automatic consolidation is disabled for the whole indexed bank, not only for indexed documents.
- Document IDs include the absolute source path. The first run after this change re-retains every document, which costs extraction time on the model server.
- Concurrent `--apply` runs (the watcher and a manual run) serialize through a lock on `state.json.lock`.

Set `INDEXER_DRY_RUN=1` to log the commands the watcher would run without executing them.

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
