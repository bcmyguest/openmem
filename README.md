# Local Hindsight memory

Docker Compose setup for the local Hindsight coding-agent memory. It runs two services:

- `hindsight`: the Hindsight API on `127.0.0.1:8888`, control plane on `127.0.0.1:9999`. Its database lives in the named volume `hindsight-data` (mounted at `/home/hindsight/.pg0`).
- `indexer`: indexes project repositories and Obsidian vaults into Hindsight, then re-indexes on change.

## Prerequisites

- Docker with Compose v2.
- An OpenAI-compatible model server for extraction:
  - lemond on this machine at `127.0.0.1:13305/v1` (containers reach it via `host.docker.internal`).
  - Elsewhere, Ollama. Its host must listen on all interfaces (`OLLAMA_HOST=0.0.0.0:11434`).

## Quick start

```sh
mkdir -p ~/.config/hindsight
cp config/hindsight.env.example ~/.config/hindsight/hindsight.env
chmod 600 ~/.config/hindsight/hindsight.env
$EDITOR ~/.config/hindsight/hindsight.env   # set HINDSIGHT_API_LLM_API_KEY and the model settings
docker compose up -d
curl -fsS http://127.0.0.1:8888/health
```

`compose.yaml` reads the env file from `$HINDSIGHT_ENV_FILE`, defaulting to `~/.config/hindsight/hindsight.env`. That file holds a secret and stays out of the repository; `.gitignore` lists it as a safety net.

To switch models, edit `HINDSIGHT_API_LLM_BASE_URL`, `HINDSIGHT_API_LLM_MODEL`, and `HINDSIGHT_API_LLM_API_KEY` in the env file, then run `docker compose up -d hindsight`. The example includes a commented Ollama block (`qwen3.5:4b` at `http://host.docker.internal:11434/v1`).

## Coding-agent plugin (external)

The client plugin is installed separately, not by this repository:

```sh
npx @vectorize-io/hindsight-coding-agents install claude-code codex opencode
ln -s ~/personal-memory/config/coding-agent.json ~/.hindsight/coding-agent.json
```

`config/coding-agent.json` sets the plugin options, including `optInPaths` (`/home/example`). The indexer reads the same file, through the `$HOME` mount.

## Indexing

The indexer runs one full pass at startup. After that, each source is re-indexed once its files have been quiet for 30 seconds.

- Repositories: discovered under `$HOME`. The indexer reads tracked files and runs CodeGraph in each one, which creates `.codegraph/` directories.
- Obsidian vaults: `~/Documents/Personal`, `~/Documents/Work`, and `~/Documents/Acme Notes`. Each uses the bank `obsidian::<slug>`.
- `optInPaths` filters sources. A missing file means no filter; an empty list means nothing is indexed.
- Automatic consolidation is disabled for the whole indexed bank, not only for indexed documents.
- Watch limits: dot-prefixed paths are ignored (including `.git`). Repositories created after startup are picked up only after `docker compose restart indexer`.

Manual runs (the script defaults to a dry run; `--apply` writes):

```sh
hindsight-project-index --list                 # selected sources
hindsight-project-index --repo PATH --apply    # one repository
hindsight-project-index --vault PATH --apply   # one vault
```

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
