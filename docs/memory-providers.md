# Pluggable memory providers

This repo today ships **one** supported backend: [Hindsight](https://github.com/vectorize-io/hindsight)
(API + retain/reflect/consolidate, LiteLLM in front of local models). The goal is to treat Hindsight as
the first **memory provider plugin**, not as implicit global state, so other stores (**mem0**, **Cognee**,
or a hosted API) can be added without rewriting indexing and setup from scratch. Wave 2 adds indexer
sinks and compose profiles for those providers; manifests under `providers/` show `planned` vs
`supported` today.

## Meta setup wizard (what this is — and is not)

`./setup` is a **meta** wizard: it orchestrates **machine-local plumbing** that is the same idea
across providers (Docker project, ports, indexer sources, smoke “is the API alive?”, coding-agent
symlink, compose up/down). It does **not** replace each provider’s **native** settings UI, CLI, or
config format.

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
- **`indexer`**: env var for API base URL, sink driver id (for future Python dispatch)
- **`codingAgent`**: optional npx package and config template path
- **`wizard`**: smoke test bank name and HTTP paths (templates may include `{bank}`)

Default provider id: **`hindsight`**. Change it in **interactive `./setup`** (Clack “Memory provider”,
defaults to `wizard.conf` / `machine.env`), or set `MEMORY_PROVIDER` for `--yes`. The wizard records
the choice in `wizard.conf`. Stack **up** / **down** are wizard actions (`--up`, `--down`, or Clack
first step); default action is full **configure and start**.

## Suggested implementation phases (separate commits)

### Phase A — Registry and docs (this commitset)

- Manifests for `hindsight` (supported) and `mem0` (planned).
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

### Phase C — mem0 (or first alternate provider)

- `providers/mem0/manifest.json` → `supported`, compose overlay or external URL-only mode.
- `indexer/sinks/mem0.py` implementing the sink protocol.
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
