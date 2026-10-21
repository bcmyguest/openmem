# Memory export and import

Portable **export/import** lets you inspect what a provider stores, move data when you change backends, and satisfy “give me my data” requests. There is **no** industry-standard memory file format yet; personal-memory defines a small **PMM** (Personal Memory Manifest) envelope so tools and future providers can converge.

Status: **`memory_export` / `memory_import`** on the unified MCP are **beta for mem0**; Hindsight and Cognee export is **partial** (see below). The format is stable at version `1`.

## PMM format (version 1)

JSON object (or JSONL with one PMM object per line for streaming):

| Field | Type | Meaning |
| --- | --- | --- |
| `pmm_version` | `1` | Schema version |
| `exported_at` | ISO-8601 string | When the export was taken |
| `source_provider` | string | `hindsight` \| `mem0` \| `cognee` |
| `scope` | object | Provider-specific filter (bank, `user_id`, datasets, …) |
| `records` | array | Normalized memory records (see below) |

Each **record**:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string \| null | Provider id when known |
| `content` | string | Primary text |
| `metadata` | object | Optional tags, timestamps, provider payload |
| `scope_key` | string | Bank name, mem0 `user_id`, Cognee dataset, etc. |

Import accepts PMM with `merge_strategy`:

| Strategy | Behavior |
| --- | --- |
| `skip_duplicates` (default) | Skip records whose `id` already exists (mem0) |
| `overwrite` | Re-import all records (may duplicate on backends without idempotent upsert) |

**Cross-provider import** (e.g. PMM from mem0 into Hindsight) is best-effort: we map `content` + `scope_key` into the active provider’s add API; embeddings and graph structure are **not** preserved.

## Unified MCP tools

On the `personal-memory` MCP server (see [Architecture](architecture.md)):

```text
memory_export   { format?: "json"|"jsonl", bank?: string, user_id?: string }
memory_import   { data: string, merge_strategy?: "skip_duplicates"|"overwrite" }
```

Restart Cursor Agent after `npx personal-memory install-mcp --yes`.

## Provider behavior

| Provider | Export | Import |
| --- | --- | --- |
| **mem0** | `GET /memories` with `user_id` / `run_id` from scope (API key from env file) | `POST /memories` per record (`infer: false`) |
| **Hindsight** | No list API in PMM yet — export returns scope + empty `records` and a note to use bank APIs or plugin | `POST …/banks/{bank}/memories` per record |
| **Cognee** | Not listed in PMM v1 — use Cognee REST export | `POST /api/v1/add` per record when dataset in scope |

## Related

- [Architecture — provider interface](architecture.md#how-personal-memory-interfaces-with-providers)
- [mem0](mem0.md) · [Cognee](cognee.md)
