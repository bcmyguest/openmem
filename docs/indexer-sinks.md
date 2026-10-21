# Indexer sink drivers

The shared indexer (`bin/hindsight-project-index`, watcher, compose `indexer` service) turns
repositories and Obsidian vaults into documents and writes them through a **sink**: a Python module
under `indexer/sinks/<name>.py`. Provider manifests declare how compose and the wizard wire that
sink; see [Pluggable memory providers](memory-providers.md) for manifests and wizard ownership.

## Manifest fields vs runtime ids

| Concept | Where it lives | Role |
| --- | --- | --- |
| **`indexer.sink`** | `providers/<id>/manifest.json` | Module name: `indexer/sinks/<sink>.py`. Becomes `MEMORY_SINK` in compose and `--sink` on the CLI. |
| **`indexer.sinkDriver`** | same | Human-readable wire-dialect label only (for docs and status pages). **Does not** select a module. |
| **`indexer.apiUrlEnv`** | same | Name of the env var the wizard documents for the provider API base URL on the host. |

Registered providers today:

| Provider | `sink` (module) | `sinkDriver` | `apiUrlEnv` |
| --- | --- | --- | --- |
| Hindsight (`supported`) | `hindsight` | `hindsight-rest-v1` | `HINDSIGHT_URL` |
| mem0 (`experimental`) | `mem0` | `mem0-rest` | `MEM0_API_URL` |
| Cognee (`experimental`) | `cognee` | `cognee-rest` | `COGNEE_API_URL` |

Contract tests: `indexer/tests/sink_contract.py`, provider-specific tests under `indexer/tests/`.

## Choosing a sink and API URL

| Input | Meaning |
| --- | --- |
| `--sink NAME` | Sink module name. Default: `$MEMORY_SINK`, then `hindsight`. |
| `MEMORY_SINK` | Set in compose fragments for mem0/Cognee (`providers/*/compose.yaml`). |
| `--url URL` | Overrides all URL env vars for this run. |
| `HINDSIGHT_URL` | API base for the **hindsight** sink only (default `http://127.0.0.1:8888`). |
| `MEMORY_API_URL` | API base for **every non-Hindsight** sink (mem0, Cognee). Required for those sinks when `--url` is omitted. |

Resolution order in the CLI: `--url` → `HINDSIGHT_URL` (hindsight sink) or `MEMORY_API_URL` (other
sinks) → sink-specific default (Hindsight only). Credentials are read inside each sink’s `create()`
from provider-specific env vars, never from indexed file paths.

Provider secret files (mode `600`, outside the repo):

| Provider | Typical file | Indexer-relevant keys |
| --- | --- | --- |
| mem0 | `~/.config/personal-memory/mem0.env` | `MEM0_API_KEY` → `X-API-Key` on API calls (not on `GET /docs` health) |
| Cognee | `~/.config/personal-memory/cognee-indexer.env` | `COGNEE_API_KEY` when the server requires auth (default single-user image does not) |

Stack `.env` holds host ports and derived URLs (for example `MEM0_INDEXER_URL` for the indexer
container’s view of mem0). LLM keys for Cognee cognify live in `cognee.env`, not in the indexer env
file — see [Cognee](cognee.md).

## Indexer `bank` → provider namespace

The indexer uses **`bank`** for the logical scope of a source (repo, vault, or `index.yml` override).
Examples: `coding-agent::my-repo`, `obsidian::my-vault`, `notebooklm::work-notes` (when synced into
Hindsight). **`doc_id`** is a stable per-document id (`project-index:v1:…`). Each sink maps `bank` /
`doc_id` to its backend’s scoping model.

### Hindsight (`hindsight-rest-v1`)

| Indexer field | Hindsight API |
| --- | --- |
| `bank` | Bank id in the path: `/v1/default/banks/{bank}/…` (URL-encoded) |
| `doc_id` | Carried in retain payload / document identity for updates and deletes |

Behavior:

- `prepare(bank)` ensures the bank exists, sets retain strategy `project-index`, disables auto-consolidation for indexed banks.
- Retains are **synchronous** (`async: false`); no `flush()` hook.
- Default URL when unset: `http://127.0.0.1:8888`. Compose sets `HINDSIGHT_URL: http://hindsight:8888` on the indexer service.

NotebookLM sync writes into Hindsight banks `notebooklm::<slug>`; that path is separate from sink
selection (still the hindsight sink when `MEMORY_PROVIDER=hindsight`).

### mem0 (`mem0-rest`)

| Indexer field | mem0 REST field |
| --- | --- |
| `bank` | `user_id` (via `scope_id()` — see below) |
| `doc_id` | `run_id` (same `scope_id` rules) |
| (fixed) | `agent_id` = `personal-memory-indexer` (provenance only; lookups use `user_id` + `run_id`) |

**`scope_id`:** If the id has no whitespace, it is used as-is. Otherwise whitespace runs become `_`,
and `~` plus the first 8 hex digits of SHA-256(original) are appended so ids that differ only in
whitespace stay distinct (for example `obsidian::My Vault` → `obsidian::My_Vault~<8 hex>`).

Documents are chunked (max 3000 characters per chunk, `infer: false`). Updates list existing memories
for `(user_id, run_id)`, write new chunks, then delete old ids. There is no mem0 “bank” to create;
`prepare` is a no-op.

Compose: `MEMORY_SINK=mem0`, `MEMORY_API_URL=${MEM0_INDEXER_URL}` (wizard derives this from host
`MEM0_API_URL`). Operator runbook: `providers/mem0/OPERATOR.md`, [mem0](mem0.md).

### Cognee (`cognee-rest`)

| Indexer field | Cognee concept |
| --- | --- |
| `bank` | **Dataset name** derived from `bank` (not the raw string) |
| `doc_id` | Stored in upload `external_metadata` as `doc_id` (plus `bank`); used to replace/delete rows |

**Dataset name:** `<slug>_<8 hex of sha256(bank)>` where `slug` is `bank` lowercased, non-`[a-z0-9]`
collapsed to `_`, trimmed, max 40 chars (empty → `bank`). Two banks that slug identically still differ
by hash suffix.

Ingestion is **asynchronous**: `retain`/`delete` call REST add/delete; the sink implements **`flush(bank)`**
to trigger `POST /api/v1/cognify` for that dataset after each changed batch (and retries pending flushes
from indexer state). Search lags until cognify completes.

Compose: `MEMORY_SINK=cognee`, `MEMORY_API_URL: http://cognee:8000`, optional
`cognee-indexer.env` for `COGNEE_API_KEY`. Operator notes: [Cognee](cognee.md).

## Optional `flush()` (Cognee)

Sinks with `capabilities.async_ingest=True` may define `flush(bank)`. The indexer calls it on
`--apply` after retains/deletes for that bank, and persists `::flush-pending` in state when a flush
fails. Hindsight has no flush. Details: [Pluggable memory providers — Optional flush](memory-providers.md#optional-flush).

## Related

- [Indexing](indexing.md) — sources, `index.yml`, watcher timings
- [Architecture](architecture.md) — unified MCP mapping to the same backends
- [MCP install guide](mcp-install-guide.md) — Cursor servers vs indexer sinks
