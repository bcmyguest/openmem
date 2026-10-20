# Wave 3: proper mem0 and Cognee support

Working document. Excluded from the npm package (`!docs/WAVE*`). Goal: close the gaps that keep
mem0 and Cognee at `experimental` so they are **operator-ready** (and promote to `supported` only
when a live E2E is recorded).

Wave 2 shipped sinks, compose, wizard hooks, and stub tests. Leftover: slice **F** secrets review,
formal M2/M3/C2/C3 reviewer sign-off, coding-agent story, README/operator docs, Cognee live path
(Ollama as LLM), mem0 DX.

## Decisions

| Decision | Choice |
| --- | --- |
| Promotion bar | `supported` only after a recorded live E2E. Otherwise stay `experimental` with hardened DX. |
| Cognee LLM for live | Prefer local Ollama (`LLM_PROVIDER=ollama`, endpoint reachable from the cognee container). No cloud key required. |
| mem0 deployment | Stay URL-only for v1; improve DX and document coding-agent. Docker mem0 service remains a follow-up. |
| Coding-agent | No fake `pluginPackage`. Document SDK/MCP/direct-API paths; optional `setupCodingAgent` that prints install steps. |
| Commits | Workers do not commit. Orchestrator commits per slice after review. |
| File ownership | Disjoint inside a round (same rule as Wave 2). |

## Cross-cuts (this session, outside provider slices)

| Issue | Fix |
| --- | --- |
| Obsidian notes not found | Wizard scanned `~/work`; vault lives under `~/work-notes`. Multi-root + explicit vault paths in index wizard; update this host's `index.yml`. |
| `./setup` only | Package already has `personal-memory setup`; add `npm run setup` and make the checkout `./setup` story match the published CLI. |

## Slices

| # | Slice | Owner files | Depends on |
| --- | --- | --- | --- |
| F | Secrets review of Wave 2 surface (read-only) | — | Wave 2 I |
| R-M | Reviewer: mem0 compose+wizard (M2/M3 catch-up) | read-only `providers/mem0/**` | Wave 2 |
| R-C | Reviewer: Cognee compose+wizard (C2/C3 catch-up) | read-only `providers/cognee/**` | Wave 2 |
| CA-M | mem0 coding-agent + operator docs in provider tree | `providers/mem0/**` (not README) | R-M |
| CA-C | Cognee coding-agent + Ollama LLM wiring in wizard | `providers/cognee/**` (not README) | R-C |
| C-LIVE | Cognee live E2E vs real image + Ollama; sink/smoke fixes | `indexer/sinks/cognee.py`, `indexer/tests/test_cognee*`, `providers/cognee/lib/smoke.mjs` | CA-C |
| M-DX | mem0 DX: toml example, validate polish, smoke edge cases | `providers/mem0/**`, `indexer/tests/test_mem0*`, `config/personal-memory.toml.example` | CA-M |
| I3 | Integrator: README, memory-providers.md, WAVE2/3 ledgers, promote only if C-LIVE green | `README.md`, `docs/*`, manifests | all |
| F3 | Final secrets review of Wave 3 diff | read-only | I3 |

## Acceptance (proper / experimental-hardened)

1. F and R-M / R-C findings addressed or explicitly deferred with reason.
2. Coding-agent story documented per provider; wizard step is not a silent skip.
3. Cognee wizard can target compose/host Ollama without an OpenAI key.
4. When Ollama is up: Cognee `docker compose up` + smoke (or recorded live script) succeeds.
5. mem0 `--yes --dry-run` and stub tests green; operator runbook clear.
6. No secrets in stack `.env` / `wizard.conf` / logs.
7. Hindsight regression tests still green.

## Promote to `supported` (extra)

- Live E2E evidence checked into docs (or ledger) for that provider.
- Manifest `status: supported`, notes rewritten, site sync.

## Slice ledger

| Slice | Worker | Reviewer | Notes |
| --- | --- | --- | --- |
| F | — | done ([F secrets](089f1a88-f7fd-4c78-923c-1be422c3cb8f)) | Cognee B1 echo key, B2 scrub env |
| R-M | — | done ([R-M mem0](1e0eac22-2bb3-419b-b5c4-e66023c79a42)) | no §2.1 blockers; CA-M/M-DX warnings |
| R-C | — | done ([R-C Cognee](2f338fee-860b-4bc3-87c9-41867dfa2847)) | Ollama endpoint, embeddings, sink metadata |
| CA-M | done ([mem0 worker](402f1dd3-ffc6-45e6-8895-12224782c33f)) | approved ([mem0 review](af3e2c31-d976-42c0-95d1-9ab970abdbdb)) | coding-agent + OPERATOR.md + smoke/validate |

| CA-C | done ([CA-C Cognee](2f191628-726c-4d87-b7f8-13cda1ba8dd4)) | approved ([CA-C review](5d24dac2-609c-456e-8d0e-b96717dc7e4d)) | secrets + Ollama + codingAgent |
| C-LIVE | done (live E2E 2026-10-20) | sink approved ([sink review](12cb993d-4601-40cd-9436-1c1bf1788e86)); doc-only status UUID note | see **C-LIVE evidence** below — **do not promote** yet |
| M-DX | done (in mem0 worker) | approved (with CA-M) | |
| I3 | done (this session) | n/a | README/npm setup/notes + compose-Ollama endpoint docs; **not** promoting to `supported` |
| F3 | — | covered by [F secrets](089f1a88-f7fd-4c78-923c-1be422c3cb8f) + CA-C review | Cognee B1/B2 fixed; mem0 already clean |

### C-LIVE evidence (2026-10-20, this host)

**Setup**

- Project: `PM_PROJECT=pm-cognee-live` (did not touch `personal-memory` / profile `hindsight`).
- Image: `cognee/cognee@sha256:29427e968f8b273db0bb7b037a7bb119d7695d960f73a59d649f00c5111a85bd` (1.6.5).
- Port: `127.0.0.1:8766` (`COGNEE_PORT=8766`).
- Env: `~/.config/personal-memory/cognee.env` (mode 600) — Ollama block with
  `LLM_PROVIDER=ollama`, `LLM_API_KEY=ollama`, `LLM_MODEL=gemma4:e2b`,
  embeddings `nomic-embed-text:latest` (pulled into `personal-memory-ollama-1`).
- Endpoint reality: CA-C default `http://host.docker.internal:11434` **connection refused**
  from the Cognee container because compose Ollama is published as `127.0.0.1:11434` only.
  Live run used `LLM_ENDPOINT=http://ollama:11434` (+ matching `EMBEDDING_ENDPOINT`) after
  `docker network connect personal-memory_default pm-cognee-live-cognee-1`.
- `COGNEE_SKIP_CONNECTION_TEST=true` needed: structured-output LLM probe often exceeds 30s
  with `gemma4:e2b` under load (standalone probe ~18s when warm).

**HTTP results**

| Step | Result |
| --- | --- |
| `GET /health` | **pass** `{"status":"ready","health":"healthy","version":"1.6.5-local"}` |
| `POST /api/v1/datasets` | **pass** 200 |
| `POST /api/v1/add` (multipart + `external_metadata` doc_id) | **pass** 200 `PipelineRunCompleted` |
| `GET .../datasets/{id}/data` | **pass** — lists doc; `externalMetadata` is a **dict** with `doc_id` (sink/smoke already accept dict/list/JSON string) |
| `POST /api/v1/cognify` `runInBackground:true` | **pass** HTTP 200 `PipelineRunStarted` (with skip-connection-test) |
| Cognify pipeline finish | **fail / stuck** — `extract_graph_and_summarize` retries: `SummarizedContent` pydantic `string_type` on `gemma4:e2b` (unvalidated Ollama model); status stayed `DATASET_PROCESSING_STARTED` for >10 min |
| `POST /api/v1/search` (CHUNKS / HYBRID) | **fail** 404 empty graph (expected until cognify completes) |
| `GET /api/v1/datasets/status?dataset=<name>` | **API quirk** — needs **UUID**, not name (sink docstring updated) |
| Hindsight stack | **untouched** — stayed healthy on `:8888` throughout; live project `compose down` afterwards |

**Code fixes**

- `indexer/sinks/cognee.py` — docstring only: status query takes dataset UUID.
- No smoke.mjs / retain-path API mismatches found against 1.6.5 OpenAPI.

**Blockers for `supported` promotion**

1. Cognify graph build must complete + search must return a known fact (needs a Cognee-validated Ollama model, or cloud LLM) — `gemma4:e2b` is insufficient for structured extraction.
2. Operator path for compose-Ollama: document/use `http://ollama:11434` on a shared compose network (or publish Ollama beyond loopback) — bare `host.docker.internal` does not work with this repo's default Ollama port bind.
3. Optional: set `HUGGINGFACE_TOKENIZER` / drop `:latest` from embedding model id (HF tokenizer id warning with `nomic-embed-text:latest`).
