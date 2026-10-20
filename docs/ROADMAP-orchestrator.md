# Orchestrator roadmap: npx meta wizard, multi-provider, GitHub Pages

Status: plan written 2026-10-19 after an adversarial review of the first draft.
Baseline: all of `scripts/tests/test_*.mjs` and `bash scripts/tests/test_wizard.sh` pass.
Rollback point: `/tmp/personal-memory-pre-orchestration-*.tgz` (the tree is uncommitted).

## Phase 0 findings (hostile review)

### Wrong abstractions

1. **"Meta" steps are Hindsight steps.** `setupEnv`, `runSetupSh` (`scripts/setup.mjs`), `llmWired`,
   `validateMemorySetup`, `resolvePorts`, `summary`, `providerApiBase` (`ctx.hindsightUrl`) and
   `smokeTest` error text are all Hindsight-specific, although `docs/provider-wizard-hooks.md` lists
   `meta.secrets` as shared. A mem0 run today would create `hindsight.env`, `litellm.env` and demand
   `HINDSIGHT_PORT`. Moving only `chooseBackend` (the original plan) is not enough: hooks must own
   secrets/env, ports, validation and the summary too.
2. **`compose.yaml` is not provider-aware.** `hindsight`, `litellm` and `indexer` have no profiles and
   `indexer` hard-depends on `hindsight`. `docker compose up -d` starts Hindsight for every provider.
   Provider selection needs compose profiles or per-provider fragments before any second provider.
3. **No indexer sink exists.** `bin/hindsight-project-index` (444 lines) talks to
   `/v1/default/banks/...` directly. mem0 and the second provider both need `indexer/sinks/*` first.
   Phase B in `docs/memory-providers.md` was never done; it gates both providers.
4. **Helpers are a leaky API.** `ProviderWizardHelpers` exposes `chooseBackend`, `act`, `info`. Moving the
   model UI needs `ask`, `confirm`, `step`, `ok`, `warn`, `die`, `commandExists`, `loadMachineEnv`.
   Version the helper API (`helpers.apiVersion`) so provider modules cannot silently break.
5. **Smoke contract is Hindsight-shaped** (`retainPath` + `{bank}` + `recallMustMatch`). Cognee's
   `add` -> `cognify` -> `search` is asynchronous and multipart; mem0 uses `user_id`, not banks. The
   manifest `wizard.*` block must allow a provider-owned `smoke` hook that overrides the HTTP template.
6. **`pm` is a bad global bin name** (Android `pm`, generic). Ship `personal-memory` (and `./pm` only
   inside a checkout).

### Circular dependencies / concurrency

- Providers must import only leaf modules (`log`, `prompts`, `exec`, `curl`) or receive `helpers`; never
  `run-wizard.mjs`. Add a test that greps `providers/**` for `run-wizard`.
- The working tree has 21 uncommitted paths, so git worktrees (`best-of-n-runner`) cannot see the
  baseline. Parallel workers share one tree and therefore get **strict file ownership** (below). Shared
  files (`test_wizard.sh`, `registry.mjs`, README, `docs/memory-providers.md`) are integrator-only.

### npx packaging footguns

- **Read-only / ephemeral package dir.** The wizard writes `.env`, `.build-hash`,
  `compose.override.yaml` into `REPO`, derived from `__dirname`. Under `npx` that is the npm cache, which
  is read-only-ish and garbage-collected; compose bind paths would break. The CLI must materialize the
  stack assets into a stable state dir (`${XDG_DATA_HOME:-~/.local/share}/personal-memory/stack`) and run
  the wizard with `PM_STACK_ROOT` pointing there. Never overwrite generated files on version upgrade.
- **Dependencies live in `wizard/package.json`**; npx installs the root package's deps. Move
  `@clack/prompts` / `@iarna/toml` to the root `package.json`; drop `ensureWizardDeps` for the packaged path.
- `files` whitelist must include `compose.yaml`, `indexer/`, `bin/`, `config/`, `providers/`, `scripts/`,
  `wizard/lib`, `wizard/bin`; exclude `site/`, `docs/ROADMAP*`, `.env`, `config/machine.env`,
  `compose.override.yaml`, `.codegraph/`, `*.pyc`. `npm pack --dry-run` must be a CI gate that also
  fails on anything matching `machine.env|\.env$|override|\.pyc|/home/`.
- npm drops symlinks (`./setup`). The CLI is a real file `cli/personal-memory.mjs`.
- `engines.node >=20`; macOS bash is 3.2, so the CLI is Node-only. Existing `scripts/*.sh` stay
  secondary.
- Provenance (`npm publish --provenance`) requires a **public** repo; `bcmyguest/personal-memory` is
  **PRIVATE** today. Pages on a private repo needs a paid plan. Visibility is a user decision (gate G5).
- Name availability checked 2026-10-19: `personal-memory` and `@bcmyguest/personal-memory` both 404 on
  npm (free). Recommend unscoped `personal-memory` (opencode-clm is unscoped too); fallback scoped.
- Important correction to the brief: **opencode-clm is an OpenCode plugin installed via
  `opencode plugin opencode-clm`, not an npx wizard** (no `bin`). The pattern worth copying is its
  release engineering: `files` whitelist, `ci.yml` with SHA-pinned actions, `npm pack --dry-run`,
  `cliff.toml` + prepare-release/release workflows, CodeQL, `SECURITY.md`, `publishConfig.access=public`.
  The wizard UX pattern comes from switchplinth's `switchplinth setup` instead.

### GitHub Pages security

- Use the Actions deployment (`upload-pages-artifact` + `deploy-pages`), not a `gh-pages` branch;
  `permissions: contents: read, pages: write, id-token: write` only; pin actions to SHAs; no secrets.
- Trigger on `push` to the default branch with `paths:` filter and `workflow_dispatch`; never
  `pull_request_target`.
- Privacy gate on the built `dist/` (switchplinth does this): fail on `/home/`, `host.docker.internal`
  host names that identify the operator's boxes, tokens, `.env` content, `LITELLM_MASTER_KEY` values.
  The current docs mention operator-specific hosts; the site build must not copy raw `docs/` blindly.

### Provider API drift

- mem0: OSS `server/` has **no** `/v1/` prefix (`POST /memories`, `POST /search`, port 8888 in compose,
  8000 raw), auth on by default (`X-API-Key`/JWT, `JWT_SECRET` required), OpenMemory (`/api/v1`, port
  8765) is a different, sunset product with an unauthenticated-API advisory. Target only `server/`. Pin the
  image tag/digest; record the version in the manifest.
- Cognee: endpoints are `/api/v1/*`, health is `/health` (not under `/api/v1`), `ENABLE_BACKEND_ACCESS_CONTROL`
  defaults true. Newer `remember`/`recall` exist alongside `add`/`cognify`/`search`; pin one flow.
- Hindsight image pinned by digest already; keep.

### Test gaps

- No test that `MEMORY_PROVIDER=mem0 --dry-run` avoids Hindsight files/ports.
- No contract test per sink (HTTP stub server) and no live smoke recorded for non-Hindsight providers.
- `test_wizard.sh` is monolithic; new providers add `test_provider_<id>.mjs` and integrator wires them.
- Tests must never touch the operator's live stack: **project `personal-memory`, ports 8888/9999, and the
  repo-root `.env`/`compose.override.yaml` are in use right now.** Workers use scratch `HOME`,
  `PM_PROJECT=pm-test-<id>`, and ports >= 18000.

## Second provider (not mem0): Cognee

Evidence (web research 2026-10-19):

| Candidate | Stars | Self-host | Fit for "index repos/vaults, recall later" |
| --- | --- | --- | --- |
| Zep (server) | ~5k (examples repo) | **No**: Community Edition retired Apr 2025 | Rejected |
| Graphiti (Zep engine) | ~29.6k-31.6k | Yes, needs FalkorDB/Neo4j + own service layer (repo has a FastAPI `server/`) | Message/episode model; one LLM extraction per episode; weak "document" fit |
| Letta | ~24-25k | Yes (Apache-2.0) but agent runtime, Postgres state | Not a memory store; no documented MCP server |
| Cognee | ~31.0k | Yes: Docker image `cognee/cognee`, keyless demo mode (local GLiNER + fastembed), Apache-2.0 | Built to ingest documents/code into graph+vector memory; REST `/health`, `/api/v1/add|cognify|search`; MCP server; docs list coding-agent use |
| Basic Memory | ~4k | local-first, stdio MCP | No REST ingest |

Choice: **Cognee**. Rationale: popularity comparable to the top non-mem0 options, a real self-host story
with a one-container try-out and a keyless mode (best chance of a *live* smoke without cloud keys),
document ingestion semantics match the indexer, and a REST surface close enough to a sink protocol.
Risks: async `cognify`, auth default, LLM cost, API churn. Fallback if the live smoke cannot pass: Graphiti
FastAPI server on FalkorDB.

## Dependency graph and file ownership

```
G0 baseline green  ->  Wave 1 (parallel, disjoint files):
    W1 Hindsight refactor + meta decoupling   owns wizard/lib/**, providers/hindsight/**,
                                              docs/provider-wizard-hooks.md, scripts/tests/test_provider_wizard_hooks.mjs
    W2 Sink protocol + compose fragments      owns bin/**, indexer/**, compose*.yaml, providers/*/compose.yaml (new)
    W4 npx package                            owns package.json, cli/**, wizard/bin/**, .npmignore, release/CI workflows
    W5 Pages site                             owns site/**, .github/workflows/pages.yml
G1 (W1 + W2 merged, tests green)  ->  Wave 2 (parallel):
    W3a mem0 provider                         owns providers/mem0/**, indexer/sinks/mem0.py (+ test files)
    W3b Cognee provider                       owns providers/cognee/**, indexer/sinks/cognee.py (+ test files)
G2 -> Integration -> Review subagent -> report
```

Go/no-go gates:

- **G0** baseline suite green + tarball snapshot (done).
- **G1** hook API v2 documented; Hindsight dry-run output unchanged; `grep -r "lemond\|litellm" wizard/lib/run-wizard.mjs` empty
  (model UI lives under `providers/hindsight/`); sink protocol + `--profile`/fragment mechanism proven by a Hindsight
  regression run in a scratch compose project. No wave 2 before this.
- **G2** each new provider: manifest validates, sink contract tests pass against a stub, `--dry-run` for that provider
  touches no Hindsight files. `status: supported` **only** with a recorded live retain/recall smoke; otherwise
  `experimental`.
- **G3** `npm pack --dry-run` file list reviewed; `npx ./personal-memory-*.tgz --help` works from a clean dir.
- **G4** site builds with the privacy check; no operator-specific strings in `dist/`.
- **G5 (user)** repo visibility, npm account/2FA/token or trusted publishing, Pages enablement.

## Wave 2 integrator edits (not allowed inside provider workers)

`scripts/tests/test_wizard.sh` wiring, README provider table, `docs/memory-providers.md`, `docs/personal-memory-config.md`,
`.agents/skills/*` updates, `registry.mjs` manifest-schema additions.
