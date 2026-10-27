# Wave 2 plan: mem0 and Cognee providers

Working document for the Wave 2 orchestration. It is excluded from the npm package and is not a
published site page. Slice status is filled in at the end of the wave (see "Slice ledger").

Goal: mem0 and Cognee become real providers (indexer sink, compose profile, wizard hooks, tests),
promoted from `planned` to `experimental` only if the acceptance gate below passes. Hindsight keeps
its behavior byte for byte.

## 1. Decisions that shape everything

| Decision | Choice | Why |
| --- | --- | --- |
| mem0 v1 deployment | **URL-only**: the indexer talks to a mem0 server the operator already runs. No mem0 container in this repo yet. | The current self-hosted mem0 server (JWT/API-key auth, dashboard, Postgres + pgvector) has no current published image: `mem0/mem0-api-server:latest` on Docker Hub dates from 2025-09 (pre-auth). Running it means building `server/` from a pinned git ref plus `pgvector/pgvector:pg17`, which we cannot pin by digest or verify offline. Follow-up: a `mem0` service built from a pinned ref. |
| Cognee deployment | **Docker**: pinned `cognee/cognee` image, loopback port, named volume, optional env file. | `docs/minimal-docker-compose.md` in the Cognee repo is an official single-container path (SQLite, LanceDB, Ladybug). |
| Sink tests | Separate files `indexer/tests/test_mem0_sink.py` and `test_cognee_sink.py` plus one stub module each. `test_sinks.py` is not edited. | Two workers run at once; one shared test file would collide. The contract helper is still `sink_contract.run_sink_contract`. |
| Commits | Workers do not commit or push. The orchestrator commits per slice with explicit paths, after review. | All workers share one working tree. |
| Default host ports | mem0 `18888`, Cognee `8766` (unchanged). | A stock mem0 server publishes `8888`, the Hindsight default. The wizard must never default to a port a live Hindsight stack owns. |

## 2. Primary-source API notes

### 2.1 mem0 self-hosted REST server

Sources: docs.mem0.ai "REST API Server" and "Self-Hosted Setup"; `server/main.py` and
`server/docker-compose.yaml` in github.com/mem0ai/mem0.

- **No `/v1/` prefix.** That prefix belongs to the hosted platform (`api.mem0.ai`).
- **Auth is on by default.** Send `X-API-Key: <key>`: either a per-user key (`m0sk_...`, created in the
  dashboard or `POST /api-keys` with a JWT) or the legacy `ADMIN_API_KEY`. `AUTH_DISABLED=true` opens
  everything (development only). A missing `JWT_SECRET` stops the server at start.
- **Health.** There is no dedicated health route. `GET /docs` and `GET /openapi.json` stay open;
  `GET /` redirects to `/docs`. The sink uses `GET /docs`.
- **Retain.** `POST /memories` with `{"messages": [{"role", "content"}], "user_id", "agent_id", "run_id",
  "metadata", "infer"}`. At least one of `user_id`, `agent_id`, `run_id` is required (400 otherwise).
  `infer` defaults to **true**, which asks an LLM to extract facts and rewrites or drops text. The sink
  must send **`infer: false`** so the document is stored verbatim; every message becomes one memory.
  Embeddings are still computed, so the server needs its embedder key.
- **Memory ids are server-generated UUIDs.** There is no client-supplied document id and no upsert.
  The sink therefore stores `doc_id` as the **`run_id`** and the bank as `user_id`, and finds a
  document's memories with `GET /memories?user_id=<bank>&run_id=<doc_id>`.
- **List.** `GET /memories` with an identifier filters; the result is `{"results": [...]}` and `top_k` is
  capped at 1000 (default is small: pass `top_k=1000`). With no identifier it is admin-only.
- **Delete.** `DELETE /memories/{memory_id}` needs only normal auth and answers 404 for an unknown
  id (the server maps "not found" to 404). `DELETE /memories?user_id=..&run_id=..` and `/reset` need an
  **admin** role. The sink deletes by listing, then deleting each id, so it works with a non-admin key.
- **user_id vs agent_id.** Records written with `infer=false` carry both fields on one record; records
  written with `infer=true` carry only one, so `user_id AND agent_id` filters return nothing for them.
  The sink only filters on `user_id` and `run_id`, and writes a fixed `agent_id` of
  `openmem-indexer` for provenance.
- **Metadata keys.** `data, user_id, agent_id, run_id, hash, created_at, updated_at, expiration_date` are
  reserved in the stored payload; the sink prefixes any colliding metadata key with `meta_`.
- **Search** (used by the wizard smoke): `POST /search` with `{"query", "filters": {"user_id": ...}}`
  (top-level `user_id` still works but is deprecated).
- **Event time.** No document timestamp field. The sink stores it as metadata `timestamp`.
- **Tags and context.** No native fields. Stored as metadata `tags` (list) and `context`.

### 2.2 Cognee self-hosted REST server

Sources: docs.cognee.ai REST API reference and OpenAPI spec (`cognee_openapi_spec.json`),
`docs/minimal-docker-compose.md` in github.com/topoteretes/cognee, Docker Hub `cognee/cognee` tags.

- **Image.** `cognee/cognee:1.6.5` (index digest
  `sha256:29427e968f8b273db0bb7b037a7bb119d7695d960f73a59d649f00c5111a85bd`, pushed 2026-10-16) is the
  newest non-dev tag and equals `latest`. Pin by digest and keep the tag in a comment. The minimal
  compose file uses `cognee/cognee:main`; do not copy that.
- **Port and health.** Container port 8000. `GET /health` returns 200 (liveness/readiness);
  `GET /health/detailed` also exists.
- **Auth.** `ENABLE_BACKEND_ACCESS_CONTROL=false` is the documented single-user mode: no auth, shared
  databases. With it on, every call needs `Authorization: Bearer <jwt>` or `X-Api-Key: <key>`. The
  stack ships the single-user mode on a loopback-only port; the sink sends `X-Api-Key` when
  `COGNEE_API_KEY` is set.
- **LLM.** The default needs `LLM_API_KEY` (OpenAI). Cognify fails without it. Other providers use
  `LLM_PROVIDER`, `LLM_MODEL`, `LLM_ENDPOINT`, and `EMBEDDING_*`; the wizard only handles the key and
  documents the rest in `[memory.cognee]`.
- **Datasets.** `POST /api/v1/datasets {"name"}` creates or returns the existing dataset (idempotent).
  `GET /api/v1/datasets` lists them (`id`, `name`). Delete and data endpoints use the **UUID**, never
  the name. Datasets are also created implicitly by `add` with `datasetName`.
- **Add.** `POST /api/v1/add` is **multipart/form-data**; `data` is a file upload (a JSON body or a bare
  text field fails validation). Optional `datasetName` or `datasetId`, `labels` (JSON array),
  `external_metadata` (JSON array of objects, merged into the stored record and returned on listing),
  `run_in_background`. Re-adding identical content is a no-op; a file that already exists in the dataset
  with **different content returns 409** ("this endpoint never updates a document").
- **Cognify is a separate step and is asynchronous.** `POST /api/v1/cognify {"datasets": [names],
  "runInBackground": true}` builds the graph; data is not searchable until it finishes
  (`GET /api/v1/datasets/status`). This is the `capabilities.async_ingest=True` case.
- **List data.** `GET /api/v1/datasets/{id}/data?limit=<=1000&offset=` returns `id`, `name`,
  `externalMetadata`, `label`. Not a snapshot under concurrent writes.
- **Update.** `PATCH /api/v1/update?data_id=&dataset_id=` (multipart) replaces one document and keeps
  its id. Delete-then-add is simpler and equally idempotent; the sink uses delete-then-add.
- **Delete.** `DELETE /api/v1/datasets/{dataset_id}/data/{data_id}` returns success also for an id the
  dataset does not track. A missing or inaccessible dataset yields 401/404; `DELETE .../datasets/{id}`
  removes the dataset with all documents, graph and embeddings (the wizard smoke uses it).
- **Dataset names.** Names reach file and database paths. The sink maps a bank to
  `<slug>_<8 hex of sha256(bank)>` (letters, digits, underscore), so two banks never collide.
- **Document lookup.** The sink writes `external_metadata = {"doc_id": ..., "bank": ...}` and finds the
  document in the listing by `externalMetadata.doc_id`, because the stored `name` comes from the upload
  file name and must not carry meaning.

## 3. Quirk-driven design

1. **Neither provider has a client-chosen document id**, so each sink resolves `doc_id` to its own id
   by a lookup scoped to one bank (mem0: `user_id`+`run_id`; Cognee: dataset data listing). The lookup
   is the hot path of every retain; both lookups are bounded (`top_k<=1000`, paged listing).
2. **Optional `flush()` on the sink.** Cognee needs one cognify call per dataset after a batch, not one
   per document. `sinks/__init__.py` documents an optional `flush()` that callers invoke after a bank's
   batch; the indexer calls it when present. The `Sink` protocol (a `runtime_checkable` Protocol of four
   methods) is **not** changed, so Hindsight and every existing sink are unaffected.
3. **Manifest naming.** Today `indexer.sinkDriver` holds wire-dialect labels (`hindsight-rest-v1`,
   `mem0-rest`, `cognee-rest`) that match no module. Add `indexer.sink`: the `MEMORY_SINK` value, which
   equals the `indexer/sinks/<name>.py` module name (validated with the registry's name rule).
   `sinkDriver` stays as a human-readable dialect label. Experimental providers must set both.
4. **`MEMORY_SINK` + `MEMORY_API_URL` + provider env.** Compose fragments set both variables on
   the indexer from stack `.env` values. Provider secrets (`MEM0_API_KEY`, `COGNEE_API_KEY`,
   `LLM_API_KEY`) live in `~/.config/personal-memory/<id>.env` (mode 600, outside the repo), loaded
   through a compose `env_file` with `required: false`. They never go in the stack `.env` or in
   `wizard.conf`, and are never printed.
5. **mem0 in the container.** The operator's mem0 is usually on the host. The wizard stores the
   host view in `MEM0_API_URL` (used by smoke) and writes `MEM0_INDEXER_URL` into the stack `.env`,
   which rewrites `127.0.0.1`/`localhost` to `host.docker.internal`; the fragment adds the
   `host-gateway` extra host to the indexer.
6. **Smoke.** The manifest HTTP smoke is JSON-only and has no header support, so both providers
   implement the `smoke` hook. mem0: retain with `infer=false`, `POST /search` for the fact, delete.
   Cognee: health, create dataset, multipart add, list data, delete dataset; recall is skipped
   because ingestion is asynchronous (`async_ingest`), and the wizard prints that.
7. **Planned vs stub behavior.** The two stubs throw on `--yes` configure. Experimental providers must
   not; they validate and continue.

## 4. Slices

File ownership is disjoint inside a round so workers can run in parallel in one tree.

| # | Slice | Owner files | Depends on |
| --- | --- | --- | --- |
| 0 | Shared: `flush()` hook, manifest `indexer.sink`, docs, pack exclusion | `indexer/sinks/__init__.py`, `bin/hindsight-project-index`, `indexer/tests/test_flush.py`, `wizard/lib/providers/registry.mjs`, `scripts/tests/test_provider_manifests.mjs`, `providers/hindsight/manifest.json`, `docs/memory-providers.md`, `package.json` | none |
| M1 | mem0 sink | `indexer/sinks/mem0.py`, `indexer/tests/mem0_stub.py`, `indexer/tests/test_mem0_sink.py` | none |
| C1 | Cognee sink | `indexer/sinks/cognee.py`, `indexer/tests/cognee_stub.py`, `indexer/tests/test_cognee_sink.py` | none |
| M2 | mem0 compose | `providers/mem0/compose.yaml`, `providers/mem0/lib/stack-env.mjs`, export in `providers/mem0/wizard.mjs`, compose test | M1 |
| C2 | Cognee compose | `providers/cognee/compose.yaml`, `providers/cognee/lib/stack-env.mjs`, export in `providers/cognee/wizard.mjs`, compose test | C1 |
| M3 | mem0 wizard | `providers/mem0/wizard.mjs`, `providers/mem0/lib/*` | M2 |
| C3 | Cognee wizard | `providers/cognee/wizard.mjs`, `providers/cognee/lib/*` | C2 |
| R | One fresh reviewer after each slice (7 total) | read-only | the slice |
| I | Integrator: manifests to `experimental`, site sync check, docs, full matrix | `providers/*/manifest.json`, `docs/*`, `README.md`, tests | all |
| F | Final security review of the full Wave 2 diff (secrets and env handling changed) | read-only | I |

Round order: **(0, M1, C1)** in parallel, then reviewers for those three together with **(M2, C2)**,
then reviewers for M2/C2 together with **(M3, C3)**, then reviewers for M3/C3, then I, then F.
Reviewer blockers are sent back to the slice's worker (resume), never fixed by the reviewer.

## 5. Acceptance gate (required before a manifest says `experimental`)

A provider is promoted only if all of these hold:

1. **Sink contract:** `run_sink_contract` passes against a stub that emulates the real API shape from
   section 2, plus exact request-shape assertions (path, headers, body) for retain, upsert, delete,
   delete-missing, and an awkward bank name.
2. **Manifest validation:** `validateManifest` passes at `experimental` (smoke fields, `healthPath`,
   `sinkDriver`, `sink`), and `node scripts/tests/test_provider_manifests.mjs` is green.
3. **Compose:** `docker compose config` (no `up`) for `compose.yaml` + the provider file + `--profile <id>`
   renders the expected service set and the indexer's `MEMORY_SINK` and `MEMORY_API_URL`; the
   `hindsight` profile still renders exactly the Hindsight service set; no `placeholder` image anywhere.
4. **Wizard dry run:** `MEMORY_PROVIDER=<id> ./setup --yes --dry-run` exits 0 and prints the compose
   command with the profile and files; a real run against the docker stub and an HTTP stub completes
   without touching the operator's stack or `.env`.
5. **No Hindsight regression:** `test_cli_requests_match_pre_refactor_baseline`, the Hindsight scenarios
   in `test_wizard.sh`, and `test_compose_profiles.py` are unchanged and green.
6. **Privacy:** `npm run pack:check` is clean (no operator paths, no docs/WAVE2).
7. **Secrets:** no secret in the stack `.env`, `wizard.conf`, `config.toml`, logs, or the summary.

Not required for `experimental` (kept as human steps): a first real `docker compose up` for Cognee,
a live mem0 server run, and a real LLM key.

`supported` additionally requires a live end-to-end run against the real server and a coding-agent
story; Wave 2 does not claim it.

## 6. Risks

| Risk | Mitigation |
| --- | --- |
| Sinks cannot be verified against the real servers offline | Stubs follow the OpenAPI and `main.py` shapes; manifests stay `experimental`; first real run is a listed human step. |
| mem0 `GET /memories` default `top_k` is small; a document with many chunks is truncated | Always pass `top_k=1000`; chunks are capped per document. |
| mem0 `infer` default true silently rewrites documents | Test asserts every retain body has `infer: false`. |
| Cognee 409 on changed content under the same name | Delete-then-add, with a unique upload name per version. |
| Cognee cognify per document is slow and conflicts with itself | `flush()` once per bank; skipped when nothing was retained. |
| Cognee dataset names with `::`, spaces, slashes | Slug plus hash suffix; test with the awkward bank. |
| A wizard smoke or test hitting :8888 | Tests set `PM_PROVIDERS_DIR`/`--api-url` to stubs; ports default off 8888. |
| Concurrent workers in one tree | Disjoint file ownership; orchestrator commits by path. |
| `docs/` ships in the npm package | `!docs/WAVE2*` in `package.json` `files`; check-pack asserts it. |

## 7. Slice ledger

Filled in when the wave finishes.

| Slice | Worker | Reviewer | Files touched |
| --- | --- | --- | --- |
| 0 | done (`6d68084`) | done | flush hook, manifest `indexer.sink`, docs |
| M1 | done (`7dd98d2`) | done | `indexer/sinks/mem0.py`, stubs/tests |
| C1 | done (`ecc5bb2`) | done | `indexer/sinks/cognee.py`, stubs/tests |
| M2 | done (integrator) | pending | `providers/mem0/compose.yaml`, `lib/stack-env.mjs` |
| C2 | done (integrator) | pending | `providers/cognee/compose.yaml`, `lib/stack-env.mjs` |
| M3 | done (integrator) | pending | `providers/mem0/wizard.mjs`, `lib/*`, wizard tests |
| C3 | done (integrator) | pending | `providers/cognee/wizard.mjs`, `lib/*`, wizard tests |
| I | done (`7d373cc`) | n/a | manifests `experimental`, sink hardening, docs |
| F | pending | n/a | full-wave secrets review (human or reviewer) |

**Orchestrator note:** the background [Wave 2 orchestrator](f46c40c9-014c-46b1-970d-71c9faa2d942) stopped after resume stalls; slices 0–I and the site deploy landed on `main`. Slice **F** and formal per-slice reviewer sign-off were not finished in that run.
