# Pluggable memory providers

This repo ships **one** supported backend: [Hindsight](https://github.com/vectorize-io/hindsight)
(API + retain/reflect/consolidate, LiteLLM in front of local models). **mem0** and **Cognee** are
**experimental** plugins (indexer sink, compose profile, wizard hooks, stub tests). Wave 3 hardened
operator DX (coding-agent steps, secrets, Ollama wiring); live Cognee cognify+search with a small
local model is not yet a promotion bar — see `docs/WAVE3-orchestrator.md`. Manifests under
`providers/` show `experimental` vs `supported`.

## Meta setup wizard (what this is — and is not)

`npm run setup` (checkout), `npx personal-memory setup`, or `./setup` is a **meta** wizard: it
orchestrates **machine-local plumbing** that is the same idea across providers (Docker project,
ports, indexer sources, smoke “is the API alive?”, coding-agent symlink, compose up/down). It does
**not** replace each provider’s **native** settings UI, CLI, or config format.

| This wizard owns (cross-cutting) | Provider still owns (native) |
| --- | --- |
| Pick provider + stack action (configure / up / down) | API keys, org/project ids, mem0 graph settings |
| Host ports, `HOST_UID`/`HOST_GID`, compose project name | Hindsight retain/reflect models beyond our LiteLLM routes |
| Shared `index.yml` (what to index) | Provider-specific memory schema, filters, user ids |
| Wiring Hindsight → LiteLLM proxy (when provider is Hindsight) | mem0 dashboard, cloud vs self-hosted choice |
| Health/smoke probes declared in manifest | Official provider docs, upgrades, migrations |

When a provider needs extra fields, the manifest should grow **provider-specific wizard steps** (or
point to “run `mem0 …` / edit `~/.mem0/…`”) — not cram mem0 into Hindsight’s LiteLLM screens.

### Similar patterns elsewhere

These are the usual analogues people mean by “meta setup”:

- **[mise](https://mise.jdx.dev/) / [asdf](https://asdf-vm.com/)** — one CLI to install and select
  runtimes; each plugin wraps the tool’s own install rules. mise does not replace `.npmrc` or
  `Cargo.toml`.
- **[Chezmoi](https://www.chezmoi.io/)** — applies dotfiles from a repo; Vim, Git, and SSH keep their
  normal config files on disk.
- **[Supabase CLI](https://supabase.com/docs/guides/cli)** — `supabase start` brings up Postgres,
  Auth, Studio; each service still has its own env and tuning.
- **LiteLLM (in this stack)** — meta proxy in front of lemond/Ollama; model servers keep their own
  configs. `./setup`’s “model backend” step is really “how LiteLLM reaches your LLM,” not a full
  lemond replacement.
- **[Home Assistant](https://www.home-assistant.io/)** — core + integrations; Philips Hue still configured
  in the Hue app, HA only links it.
- **`npx skills`-style installers** — discover and install artifacts; each skill or package owns its
  content afterward.

personal-memory sits in that category: **one front door** for “memory on this machine for coding agents,”
not a reimplementation of mem0 or Hindsight settings.

Declarative config is **[mise-like](personal-memory-config.md)**: `~/.config/personal-memory/config.toml`
plus `./pm` tasks — same *shape* as mise (`[tasks]`, merged config files), different domain.

Provider-specific setup runs via **[wizard hooks](provider-wizard-hooks.md)** (`providers/*/wizard.mjs`)
after meta steps — like asdf plugin install scripts, not reimplemented npm/mem0 CLIs.

## Layers (what varies per provider)

| Layer | Hindsight today | Should become |
| --- | --- | --- |
| **Compose stack** | `litellm`, `hindsight`, `indexer`, optional `notebooklm` | Provider manifest lists services / profiles; shared `indexer` where possible |
| **Model routing** | LiteLLM + `config/litellm.*.yaml` | Hindsight-specific; other providers may use their own LLM config or none |
| **Indexer sink** | `bin/hindsight-project-index` → REST `/v1/default/banks/{bank}/memories` | Python **sink** interface; one implementation per provider |
| **Setup wizard** | Node wizard: preflight, env, smoke retain/recall | Provider manifest: health URL, smoke steps, env file names |
| **Coding-agent UX** | `@vectorize-io/hindsight-coding-agents` + `coding-agent.json` | Per-provider plugin package or generic adapter |

NotebookLM sync is **orthogonal**: it can stay a profile regardless of memory provider.

## Provider manifest

Each provider lives under `providers/<id>/manifest.json`. The wizard loads manifests via
`wizard/lib/providers/registry.mjs`. Fields are intentionally small; expand only when a second
provider needs them.

- **`status`**: `supported` | `experimental` | `planned`
- **`compose`**: which services belong to this provider, health check, default host port env var
- **`indexer`**: env var for API base URL, `sink`, and `sinkDriver` (see the table below)
- **`codingAgent`**: optional npx package and config template path
- **`wizard`**: smoke test bank name and HTTP paths (templates may include `{bank}`)

| `indexer` field | Meaning | Required |
| --- | --- | --- |
| `apiUrlEnv` | Env var that holds the provider's API base URL for the wizard | Per provider |
| `sink` | The `MEMORY_SINK` value, which equals the `indexer/sinks/<sink>.py` module name. Must match `^[a-z][a-z0-9_]*$` (the same rule as `indexer/sinks/__init__.py`). | `supported` and `experimental`; optional but validated for `planned` |
| `sinkDriver` | Human-readable wire-dialect label (for example `hindsight-rest-v1`). It names no module and drives no dispatch. | `supported` and `experimental` |

`scripts/tests/test_provider_manifests.mjs` checks that every `supported` or `experimental` manifest
with an `indexer.sink` has a matching `indexer/sinks/<sink>.py`.

## Selecting a sink

The indexer picks its provider with `--sink NAME`, falling back to the `MEMORY_SINK` environment
variable, then `hindsight`. Compose fragments for alternate providers set both `MEMORY_SINK` and
`MEMORY_API_URL` on the `indexer` service from stack `.env` values.

| Variable | Used by | Meaning |
| --- | --- | --- |
| `MEMORY_SINK` | indexer | Sink module name (`indexer.sink` in the manifest). Default `hindsight`. |
| `MEMORY_API_URL` | indexer, every non-Hindsight sink | Generic API base URL of the provider. |
| `HINDSIGHT_URL` | indexer, Hindsight sink only | API base URL for Hindsight (default `http://127.0.0.1:8888`). |

`--url` overrides either URL variable. A sink reads its credentials from its own environment
variables inside `create`, never from the document path.

Provider secrets (for example `MEM0_API_KEY`, `COGNEE_API_KEY`, `LLM_API_KEY`) live in
`~/.config/personal-memory/<id>.env`, outside the repo, mode 600. A provider's compose fragment loads
that file through an `env_file` entry with `required: false`, so a stack without the file still
starts. Secrets do not belong in the stack `.env` or in `wizard.conf`, and the wizard never prints
them.

### Optional `flush()`

A sink for a provider that ingests asynchronously (`capabilities.async_ingest=True`, for example
Cognee, where `cognify` builds the graph after `add`) may define `flush(bank: str) -> None`. The
indexer calls it once per bank after that bank's batch of retains and deletes, so the provider starts
processing once per batch rather than once per document.

- The call happens only with `--apply`. The indexer calls `flush(bank)` with an explicit bank when the
  batch retained or deleted at least one document for that bank, **or** when a previous flush for that
  bank is still pending. A dry run never flushes, and `flush(None)` is never called.
- A sink must treat `flush(bank)` as "process this bank now", even when its own in-memory bookkeeping
  says the bank is clean: the indexer may call it from a fresh process in which that bookkeeping is gone.
- Pending flushes are persisted. Per-document progress is saved to the indexer state file as it goes, so
  a failed flush (or a run that died after some retains) would otherwise never be retried. For a sink
  with a `flush`, the bank is recorded under the state key `::flush-pending` (a sorted list of banks)
  before the first write of a batch and removed after `flush` succeeds. Every `--apply` run flushes the
  banks it handles that are still pending, even when nothing changed. A bank whose source is no longer
  indexed is left alone. Sinks without `flush` (Hindsight) never get the key, so their state file is
  unchanged.
- `flush` is not part of the `Sink` protocol, so sinks without it (Hindsight among them) still satisfy
  `isinstance(sink, Sink)` and see no change in behavior. Callers use `sinks.flush_sink(sink, bank)`,
  which does nothing when the sink has no callable `flush`.
- A flush error is handled like a retain error: the source is reported as failed, the other sources
  still run, and the pending marker stays so the next run flushes again.
- The watcher (`indexer/watch.py`) spawns this same CLI once per source, so flush runs there too. In
  the indexer container the sink and URL come from `MEMORY_SINK` and `MEMORY_API_URL`.

Default provider id: **`hindsight`**. Change it in **interactive `./setup`** (Clack “Memory provider”,
defaults to `wizard.conf` / `machine.env`), or set `MEMORY_PROVIDER` for `--yes`. The wizard records
the choice in `wizard.conf`. Stack **up** / **down** are wizard actions (`--up`, `--down`, or Clack
first step); default action is full **configure and start**.

## Suggested implementation phases (separate commits)

### Phase A — Registry and docs (this commitset)

- Manifests for `hindsight` (supported), `mem0` and `cognee` (`experimental` after Wave 2).
- Wizard reads manifest for health/smoke URLs; behavior unchanged for Hindsight.
- Document extension points (this file).

### Phase B — Indexer sink interface (implemented)

- HTTP retain/delete/health live in `indexer/sinks/`; default sink is `hindsight`.
- CLI: `--sink <name>` or env `MEMORY_SINK`; non-Hindsight sinks use `MEMORY_API_URL` for the API base.
- Contract tests: `indexer/tests/sink_contract.py` and `test_sinks.py`.

### Phase D — Compose profiles (implemented for Hindsight)

- `litellm` and `hindsight` use compose profile `hindsight`; the indexer always starts.
- `./setup` passes `--profile hindsight` on compose commands; `scripts/setup.mjs` writes `COMPOSE_PROFILES=hindsight` into the stack `.env`.
- Alternate providers layer `providers/<id>/compose.yaml` with their own profile (`MEMORY_SINK`, `MEMORY_API_URL`, `depends_on`).

### Phase C — mem0 and Cognee (Wave 2 + Wave 3 DX)

- mem0 is **URL-only** in v1: the indexer talks to a mem0 server the operator already runs, and this
  repo ships no mem0 container yet. A mem0 service built from a pinned upstream ref is a follow-up.
  Operator runbook: `providers/mem0/OPERATOR.md`. Coding-agent: wizard `setupCodingAgent` prints
  SDK/MCP steps (no fake `pluginPackage`).
- Cognee runs in **docker**: a pinned `cognee/cognee` image on a loopback port with a named volume and
  an optional env file (`~/.config/personal-memory/cognee.env`, mode 600).
  Operator notes: `providers/cognee/OPERATOR.md`. Coding-agent: REST on the loopback port plus a
  read-only stdio MCP (`cli/cognee-mcp.mjs`: `cognee_health` / `cognee_search`) registered by
  `setupCodingAgent` / `npm run install-mcp` when `MEMORY_PROVIDER=cognee`.
- **Cognee + Ollama:** default endpoints use `host.docker.internal:11434` (host Ollama on the Docker
  bridge). When this stack’s compose profile `ollama` publishes **loopback-only**
  (`127.0.0.1:11434`), that default is refused from the Cognee container. Set
  `PM_COGNEE_OLLAMA_COMPOSE=1` or `MEMORY_OLLAMA_IN_COMPOSE=1` (wizard Clack also detects
  `MEMORY_OLLAMA_IN_COMPOSE=1` in `wizard.conf`) so defaults become `http://ollama:11434` and attach
  Cognee to the same Docker network as the `ollama` service. Cognify still needs a model that can
  emit Cognee’s structured extraction schemas; small local models (for example `gemma4:e2b`) may
  pass HTTP add/cognify start but never finish the graph — stay `experimental` until a recorded
  cognify+search live E2E.
- `providers/<id>/manifest.json` stays `experimental` until that live E2E; Wave 2 only moved them
  off `planned`.
- `indexer/sinks/mem0.py` and `indexer/sinks/cognee.py` implementing the sink protocol (Cognee also
  implements the optional `flush()`).
- Wizard branch: provider select (Clack) before model backend when multiple providers are supported.
- Coding-agent story: mem0’s own SDK/plugin or a thin local proxy—document limitations.

### Phase D — Compose profiles

- `docker compose --profile hindsight` vs `--profile mem0` generated or documented from manifests.
- Avoid duplicating indexer image; only swap `depends_on` and indexer `environment`.

## mem0 notes (non-goals for Phase A)

mem0’s API and deployment model differ from Hindsight banks and retain/reflect aliases. Expect:

- Different **namespace** model instead of `bank` strings.
- Possibly **no** LiteLLM sidecar in this repo (mem0 cloud or separate compose).
- Coding-agent integration likely **not** the Hindsight npx package; manifest should name the real install path when known.

## Adding a provider (checklist)

1. Add `providers/<id>/manifest.json` with accurate `status`.
2. Implement indexer sink (Phase B+).
3. Add compose fragment or profile and document ports/env.
4. Extend wizard: provider selection, provider-specific steps, smoke test.
5. Document opt-in / agent config for that provider.
6. Extend `scripts/tests/test_wizard.sh` or add provider-specific tests.
