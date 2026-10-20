# Manual stack setup

Use this when you are not running the [setup wizard](setup-wizard.md). Commands assume your **stack root** is the current directory (git checkout or `PM_STACK_ROOT`).

## Hindsight: minimal path

```sh
mkdir -p ~/.config/hindsight
cp config/hindsight.env.example ~/.config/hindsight/hindsight.env
chmod 600 ~/.config/hindsight/hindsight.env
node scripts/setup.mjs
node scripts/setup.mjs --migrate-env   # only if hindsight.env still points at lemond/Ollama directly
docker compose up -d
curl -fsS http://127.0.0.1:8888/health
```

`scripts/setup.mjs` must run before any `docker compose` command (including `logs` and `down`). It writes stack `.env`, `compose.override.yaml`, and related files.

## Compose profiles

| Profile | Services |
| --- | --- |
| `hindsight` | LiteLLM + Hindsight API (default after wizard) |
| `ollama` | In-compose Ollama for LiteLLM |
| `notebooklm` | NotebookLM → Hindsight sync |

Plain `docker compose up` without profiles starts only the indexer unless `.env` sets `COMPOSE_PROFILES`. The wizard passes every needed `--profile` on each compose invocation.

NotebookLM is started **after** the smoke test so sync does not compete with smoke on the LLM.

## Indexer sinks

| Variable | Meaning |
| --- | --- |
| `MEMORY_SINK` / `--sink` | `hindsight` (default), `mem0`, `cognee`, … |
| `HINDSIGHT_URL` | Hindsight API from indexer container |
| `MEMORY_API_URL` | Non-Hindsight memory API |

Entrypoint: `bin/hindsight-project-index` via `indexer/sinks/`.

## What setup.mjs generates

| Output | Role |
| --- | --- |
| `.env` | `HOST_UID`, `HOST_GID`, `LITELLM_CONFIG`, `COMPOSE_PROFILES`, … |
| `compose.override.yaml` | Masks `~/.ssh`, `~/.gnupg`, `~/.config/hindsight`, agent credential dirs from the indexer; optional mount for `index.yml` |
| `~/.config/hindsight/litellm.env` | LiteLLM master key (mode 600) if missing |

The indexer runs as your UID (`user: "${HOST_UID}:${HOST_GID}"`). Writable state is only the named volume `indexer-state` (mounted at `$HOME/.cache/hindsight-project-index` inside the container); `$HOME` is read-only.

Rerun `node scripts/setup.mjs` after UID changes or when new secret directories appear (masks are generated only for paths that exist).

## Seed indexer state volume

When moving from a host `state.json` to the volume:

```bash
docker compose stop indexer
docker compose run --rm --no-deps indexer-state-init
docker run --rm --user "$HOST_UID:$HOST_GID" \
  -v "$HOME/.cache/hindsight-project-index:/src:ro" \
  -v personal-memory_indexer-state:/dst personal-memory-indexer:local \
  cp /src/state.json /dst/
```

Adjust the volume name with `docker volume ls` if the compose project name differs.

## Bench overlay (optional)

`compose.bench.yaml` also publishes Hindsight on the Docker bridge gateway for sandboxes (see the file for the bind address). Keep `compose.override.yaml` in the `-f` list when you add `-f compose.bench.yaml`.

```bash
docker compose -f compose.yaml -f compose.override.yaml -f compose.bench.yaml up -d hindsight
```
