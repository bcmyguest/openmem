# Context store contract

The context proxy, OpenMem's OpenCode 2 plugin (which trims natively instead of using the proxy), the session hooks, and the `smart_compact_*` MCP tools exchange state through local files. Below, "proxy" means whichever of the two trims a session. This page is the contract between them; change it before changing any side.

## Location

Root: `$OPENMEM_STATE_DIR/context`, default `~/.local/share/openmem/context`. Surrounding ASCII whitespace (space, `\t`, `\n`, `\v`, `\f`, `\r`) is trimmed from `OPENMEM_STATE_DIR`; an empty value after trimming means the default. Directories are mode 700, files mode 600. The context-proxy container bind-mounts this directory read-write and runs as the host UID/GID.

| Path | Writer | Reader | Content |
| --- | --- | --- | --- |
| `sessions/<sid>.json` | SessionStart hook, OpenCode plugins | proxy, MCP | Registration: `{"session_id", "agent", "cwd", "bank", "registered_at"}` (ISO 8601 UTC) |
| `sessions/<sid>.force` | prompt hook or OpenCode plugin on `/smart-compact` | proxy | Empty flag. The proxy trims on the next request for that session, then deletes the flag. |
| `sessions/<sid>.trim.json` | proxy | proxy | Proxy-private trim state (cut point, fingerprints, reported-usage samples for the token estimate, see [context-proxy.md](context-proxy.md#token-estimate)). Other components must not depend on its shape. |
| `sessions/<sid>.db` (+ `-wal`, `-shm`) | proxy | MCP `smart_compact_search`, `smart_compact_sql`, shell `sqlite3` | [Session database](#session-database): every message of the session, in or out of context. The only store of record for message content. |
| `blobs/<id>.txt` | proxy | MCP `smart_compact_get` | Full text of a compressed tool result. `id` = first 16 hex chars of SHA-256 of the UTF-8 content. |
| `.ttl-stamp` | proxy, MCP server | proxy, MCP server | Empty; its mtime records the last [retention](#retention) sweep |

Earlier releases wrote `sessions/<sid>.log.jsonl` handoff logs. Nothing writes or reads them now and they are not migrated; the retention sweep deletes them with their session.

## Session id

`<sid>` is the agent's session id after this rule, applied identically by the hooks and plugins (`sanitizeSessionId` in `cli/coding-agent/context-store.mjs`), the proxy (`sanitize_sid` in `proxy/openmem_context/store.py`) and the MCP tools:

1. Trim surrounding ASCII whitespace (space, `\t`, `\n`, `\v`, `\f`, `\r`); other whitespace is not trimmed.
2. Replace every Unicode code point outside `[A-Za-z0-9._-]` with one `_` (`😀` becomes `_`, not `__`).
3. Reject an empty result: hooks write no file, the proxy tries the next source below, the MCP tools return an error.

Dots are kept, so `..` survives (`ses/../x` becomes `ses_.._x`). That is safe because step 2 removes every path separator and each file name appends a suffix (`.json`, `.db`, ...), so no sid names a path outside `sessions/`. Registration and trimming accept such ids. The MCP tools additionally reject an explicit `session_id` argument that contains `/` or `\`, or that is `.` or `..`; pointers always give the agent the sanitized id, which never has a separator.

The proxy takes the first non-empty id, in order, from:

1. the `x-openmem-session-id` request header (sent by OpenMem's OpenCode plugin through its `chat.headers` hook);
2. the `x-claude-code-session-id` header (Claude Code; equals the hook `session_id`);
3. `metadata.user_id` JSON `session_id`, then the legacy `user_id` form ending in `_session_<id>` (8 or more of `[0-9A-Za-z-]`); the request's own `metadata` first, then `proxy_server_request.body.metadata`;
4. `prompt_cache_key` (Codex sends its conversation id there), from the request then from the original body;
5. the `session_id`, `x-session-id` and `conversation_id` headers, in that order.

Sources 3 (legacy form), 4 and 5 cover clients OpenMem does not wire yet; only Claude Code and OpenCode are wired. When no source yields an id, the proxy uses `fp-<first 16 hex of SHA-256(system prompt + first user message)>`; such sessions have no registration, so recall injection is skipped but trimming still works.

## Trim

A trim keeps, in their original order:

- pinned messages before the cut (Chat and Responses `system` / `developer` messages, OpenCode 2 `system` messages; Anthropic keeps `system` outside the message list);
- the **first real user turn**, verbatim: Anthropic, the first `user` message that is not only `tool_result` blocks; Chat, the first `user` message; Responses, the first user `message` item; OpenCode 2, the first `user` message that is not only `tool-result` parts. It usually states the task, so every trim keeps it ahead of the pointer;
- the cut turn, with the pointer block prepended, and everything after it.

A trim runs when the `.force` flag exists or the request's estimated prompt tokens reach the threshold. The estimate is calibrated from the provider's reported usage, with `CONTEXT_CHARS_PER_TOKEN` (default 2.5) as the fallback ratio ([context-proxy.md](context-proxy.md#token-estimate)); it never moves an existing cut.

The cut is the last real user turn after the previous cut whose kept part (the suffix plus the pinned first turn) shares no tool call/result pair with the dropped part. No cut exists, and the request passes unchanged, when nothing but pinned messages and the first user turn precede it; in particular, nothing changes while the first user turn is still the in-flight turn. A trim keeps the pinned first turn's rows `in_context = 1`, and the pointer's `<n>` excludes it. An OpenCode 2 compaction drops every message, the first turn included, so it marks all of the request's rows `in_context = 0`.

## Session database

`sessions/<sid>.db` is a SQLite database, one per session, in WAL mode. The proxy (Python `sqlite3`, `proxy/openmem_context/sessiondb.py`) and the OpenCode 2 plugin (`node:sqlite`, `cli/coding-agent/session-db.mjs`) write it; the MCP tools open it read-only. The file is created mode 600; SQLite gives `-wal` and `-shm` the same mode.

### Schema (`PRAGMA user_version = 1`)

A writer that finds `user_version = 0` creates these objects in one `BEGIN IMMEDIATE` transaction, in this order and with these exact statements (both writers share the strings; the parity test compares `sqlite_master`), then sets `user_version = 1`. A writer that finds any other version leaves the file alone and logs `UnsupportedSchema`; a reader skips it. A schema change bumps `user_version` and changes this section first.

```sql
CREATE TABLE messages (seq INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, thread TEXT NOT NULL,
  role TEXT NOT NULL, kind TEXT NOT NULL, name TEXT, text TEXT NOT NULL, blob_id TEXT,
  in_context INTEGER NOT NULL DEFAULT 1, trimmed_at_seq INTEGER, trimmed_at TEXT, created_at TEXT NOT NULL);
CREATE INDEX messages_thread ON messages (thread, seq);
CREATE TABLE lines (id INTEGER PRIMARY KEY, message_seq INTEGER NOT NULL REFERENCES messages (seq),
  line_no INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, UNIQUE (message_seq, line_no));
CREATE VIRTUAL TABLE messages_fts USING fts5 (text, content='messages', content_rowid='seq');
CREATE VIRTUAL TABLE lines_fts USING fts5 (text, content='lines', content_rowid='id');
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, text) VALUES (new.seq, new.text); END;
CREATE TRIGGER lines_fts_insert AFTER INSERT ON lines BEGIN
  INSERT INTO lines_fts (rowid, text) VALUES (new.id, new.text); END;
CREATE TABLE vectors (message_seq INTEGER NOT NULL REFERENCES messages (seq), model TEXT NOT NULL,
  dim INTEGER NOT NULL, blob BLOB NOT NULL, PRIMARY KEY (message_seq, model));
```

| Column | Values |
| --- | --- |
| `messages.seq` | Row id, 1, 2, … in insertion order, never reused |
| `messages.fingerprint` | Row key, below. Unique, so a resent message is never stored twice |
| `messages.thread` | Fingerprint of the first row of the row's conversation (a subagent or side request is its own thread) |
| `messages.role` | `user` · `assistant` · `tool` |
| `messages.kind` | `text` · `tool_use` · `tool_result` · `thinking` (thinking rows carry summary text only, never signatures) |
| `messages.name` | Tool name for `tool_use` / `tool_result`, else `NULL` |
| `messages.text` | Plain text; tool inputs as compact JSON; a compressed tool result in full, as the request carried it |
| `messages.blob_id` | Blob id of a tool result the view shows compressed (`smart_compact_get`), else `NULL` |
| `messages.in_context` | `1` while the latest request that carried the row also sends it to the model; `0` once a trim or compaction dropped it |
| `messages.trimmed_at_seq` | `seq` of the first row of the cut turn that dropped the row; `NULL` while in context and after a compaction (no cut turn) |
| `messages.trimmed_at` | When the row left context; `NULL` while in context |
| `messages.created_at` | When the row was stored. Timestamps are ISO 8601 UTC without fractions (`2026-10-29T17:00:00Z`) |
| `lines` | One row per `\n`-separated line of `messages.text`, `line_no` from 1, `role` copied from the message |
| `messages_fts`, `lines_fts` | FTS5 (default `unicode61` tokenizer) over `messages.text` and `lines.text`; rowid = `messages.seq` / `lines.id` |
| `vectors` | Embedding of `messages.text` (first 8000 characters) per model: `dim` float32 values, little-endian, in `blob` |

### Rows

On every request the writer turns each message that is not pinned (system and developer messages are not stored) into rows, one per content block, as the adapters always did (`adapter.rows` in Python, `logRows` in JS). The row text comes from the request's original message, so a tool result the view compresses is stored in full and its `blob_id` names the blob.

A row's fingerprint chains it to the rows before it: `fingerprint({"prev", "role", "kind", "name", "text"})`, the trim fingerprint function (`tokens.fingerprint`: SHA-256 of sorted-key compact JSON, first 32 hex), with `prev` the previous row's fingerprint (`""` for the first). A resent history therefore yields the same keys whatever its wire form (cache markers, string or block content), the same text said twice yields two rows, and a rewritten history yields new rows from the first changed one on. The chain is over rows, not wire messages, so the proxy's Chat, Anthropic and Responses adapters and the OpenCode 2 plugin produce identical rows for the same conversation.

Writes are idempotent and cheap: each writer keeps an in-memory index of the database's fingerprints (reloaded when `PRAGMA data_version` shows another connection committed), inserts only rows it has not seen, and updates `in_context` only for rows whose flag changes, all in one `BEGIN IMMEDIATE` transaction. A request that adds nothing and moves nothing writes nothing. A database error (locked past the 1 s busy timeout, disk full, newer schema) logs one `openmem-context: fail-open <type> at <file:line>` line and the request goes on with its rewritten view.

Rows that a later request no longer carries (a rewritten history) keep their last `in_context` value.

### Concurrency

One writer per session at a time is the design: the proxy serializes a session under its in-process lock, and OpenCode 2 sessions are written only by the plugin. Readers use WAL, so the MCP server reads while the proxy writes (`scripts/tests/test_session_db.mjs` runs a Python writer against a JS reader). The proxy writes from its container and the MCP server reads on the host over the bind mount. WAL needs shared memory between the processes (the `-shm` file), so this works only when both run on the same host kernel: Linux Docker with a bind mount. Docker Desktop (macOS, Windows), network filesystems and remote containers are unverified and not supported.

## Search

`smart_compact_search` (`cli/mcp/context-store.mjs`) opens each searched session's database read-only.

| Parameter | Effect |
| --- | --- |
| `query` | Words; each becomes an FTS5 string (`"word"`), so matching is case-insensitive and by token (`KEY-7` matches the tokens `key 7`). A row matches when it contains any word; rows with more words rank first, then by BM25 |
| `pattern` | JavaScript regex, at most 200 characters, tested against each row's first 20000 characters (row hits) and each line's first 20000 characters (line count), within a 1 s budget |
| `role` | `user`, `assistant`, `tool`, a list, or `all`; default `["user", "tool"]` |
| `in_context` | `true`: rows still in context; `false`: trimmed rows; omitted: both |
| `mode` | `hybrid` (default when the session has vectors) or `lexical` |
| `context` | 0–5 neighbouring rows of the same `thread`, any role, before and after each hit |
| `session_id`, `limit` | As before: one session, or recent sessions registered under the workspace's git root; result count (default 8) |

| Field | Counts |
| --- | --- |
| `total_matches` | Rows that match lexically under the filters (`query`: at least one word; `pattern`: the regex matches the row) |
| `line_matches` | Exact count of `lines` rows that match under the same filters, across the whole session: every word (`lines_fts MATCH "w1" AND "w2"`) for `query`, the regex for `pattern` (`^` and `$` per line, as `grep -c`). When the pattern budget runs out the response carries the partial count and `timed_out: true` |

`mode` in the response says which ranking ran. **Hybrid**: the MCP server embeds the query with the model that has the most vectors in the database (the configured `embedding_model` when it has vectors), takes the 50 nearest rows by brute-force cosine under the same filters, and merges them with the lexical ranking by reciprocal rank fusion (score Σ 1/(60 + rank)). Vector-only hits carry `similarity` and `matched_terms: 0`. When the query embedding fails, the response is lexical and carries `embedding_error`. `pattern` searches are always lexical.

Results carry `session_id`, `seq`, `role`, `kind`, `name`, `in_context`, an excerpt, `matched_terms` (query), `similarity` (hybrid), `blob_ids`, and `before`/`after` with `context`. `databases` maps each searched session to its database path.

## SQL

`smart_compact_sql(session_id, sql)` runs one `SELECT` or `WITH … SELECT` against one session database:

1. A statement check blanks comments, string literals and quoted identifiers, then rejects anything whose first word is not `SELECT` / `WITH`, any `;` before trailing whitespace, and any of `ATTACH DETACH PRAGMA INSERT UPDATE DELETE UPSERT CREATE DROP ALTER VACUUM REINDEX ANALYZE BEGIN COMMIT ROLLBACK SAVEPOINT RELEASE TRANSACTION` or `REPLACE INTO` (the `replace()` function is allowed).
2. A child process (`cli/mcp/context-sql-runner.mjs`) opens the database with `readOnly: true` (`SQLITE_OPEN_READONLY`, the same as `?mode=ro`). On Node ≥ 24.10 it also installs an authorizer that allows only SELECT, READ, FUNCTION, RECURSIVE and FTS5's internal `PRAGMA data_version`.
3. The parent kills the child after 2 s. At most 200 rows return, with `truncated: true` when there were more; text cells over 2000 characters are cut, and the whole result is halved until it fits 30000 characters (also `truncated`).

## Vectors

Vectors are off unless `[context_store] embedding_model` (env `CONTEXT_EMBEDDING_MODEL`) names a model. The stack ships no embedding route: Hindsight embeds locally, and the LiteLLM configs route only chat models. To turn vectors on, serve an embedding model behind an OpenAI-compatible `POST <url>/embeddings` and set:

| Setting | Env | Default | Used by |
| --- | --- | --- | --- |
| `[context_store] embedding_model` | `CONTEXT_EMBEDDING_MODEL` | empty (off) | proxy, OpenCode 2 plugin, MCP |
| `[context_store] embedding_url` | `CONTEXT_EMBEDDING_URL` | `http://127.0.0.1:11434/v1` (Ollama) | OpenCode 2 plugin and MCP, on the host |
| — | `CONTEXT_PROXY_EMBEDDING_URL` (stack `.env`) | `http://host.docker.internal:11434/v1` | the proxy container (compose passes it as `CONTEXT_EMBEDDING_URL`) |
| — | `CONTEXT_EMBEDDING_API_KEY` | empty | Bearer token, when the endpoint needs one (proxy: its env file) |

For Ollama: `ollama pull nomic-embed-text`, then `embedding_model = "nomic-embed-text"`. Embedding runs off the request path: after a request stores new rows, the proxy queues the database for one daemon thread and the OpenCode 2 plugin starts one background run per database; each embeds rows without a vector for the model, 32 per call. A failed call logs `openmem-context: embedding failed <type> at <file:line>` and that database waits 60 s before the next try. The MCP server embeds only the query. The model must be the same at every end; vectors of another model are ignored by a search that picks a different one.

## Retention

`[context_store] ttl_days` (env `CONTEXT_STORE_TTL_DAYS`, default 30; `0` keeps everything). At start, the proxy (on a daemon thread) and the MCP server sweep `sessions/`, at most once a day: when `.ttl-stamp` is older than 24 h or missing, they touch it and delete every session whose newest file is older than the TTL. A session's files are grouped by suffix (`.db`, `.db-wal`, `.db-shm`, `.json`, `.trim.json`, `.force`, `.log.jsonl`); dot files and other names are left alone. Blobs are shared between sessions and are not swept. A writer that finds its cached database deleted or replaced reopens it on the next request.

## Proxy-inserted text

Standing instruction, added to the system prompt of every request while trimming is enabled, from the first request on and before any trim:

```
Context management: to fit your context window, older turns may be removed and replaced by an [openmem: …] pointer. Removed content is saved, not forgotten. Before answering anything that depends on earlier content you cannot see in your context — values, ids, keys, counts, decisions — call smart_compact_search (use `pattern` for exact ids/keys, `context` for neighbouring rows; `line_matches` gives exact counts) or smart_compact_sql for counts and aggregates over the session store; never guess or answer from memory you cannot see.
```

It is a constant (`STANDING_INSTRUCTION` in `proxy/openmem_context/core.py` and `cli/coding-agent/context-trim.mjs`), so the system prefix is byte-identical on every request and the prompt cache keeps hitting. It is added after trimming: the cut, the token estimate and the fingerprint session id never see it. A request whose system text already contains it is left alone. `CONTEXT_STANDING_INSTRUCTION=0`, or `[context_proxy] standing_instruction = false` in config.toml, turns it off; `CONTEXT_PROXY_ENABLED=0` turns it off with the trim. Placement:

| Format | Where |
| --- | --- |
| Anthropic | One text block appended to `system`; a string `system` becomes a single leading text block first, an absent one becomes `[block]` |
| Chat | One `system` message inserted after the leading `system` / `developer` messages (index 0 when there are none) |
| Responses | Appended to `instructions` after a blank line (or set as `instructions` when absent). `instructions` precede every input item and stay fixed for a session, so a trim of `input` never moves the instruction |
| OpenCode 2 | One `{type: "text"}` entry pushed onto `event.system`, after the session banner |

Pointer block placed at the start of the cut turn after a trim:

```
[openmem: continuing session <sid>; <n> earlier messages are NOT in your context. You MUST call smart_compact_search(session_id="<sid>", query=... or pattern=...) before answering anything that depends on them; every message of this session is stored and queryable with smart_compact_search and smart_compact_sql(session_id="<sid>", sql=...).]
```

It names no file path, so the proxy (in its container) and the OpenCode 2 plugin (on the host) produce the same bytes.

Then, each on its own line and only when the registration names a bank:

1. `[openmem recall]` and at most `max_chars` characters of recalled memory, when recall returns text. `max_chars` is `CONTEXT_COMPACTION_MAX_CHARS`, else `[compaction] max_chars` in config.toml, else 12000.
2. When the bank has pending or processing ingest operations (proxy: Hindsight `operations?status=pending|processing`; OpenCode 2: `memory_status` through the session facade):

   ```
   [openmem: memory ingest is still running, so the most recent turns may not be in memory yet. Use smart_compact_search(session_id="<sid>", query=...) for them.]
   ```

The block is computed once per cut and stored in the trim state, so later requests repeat it byte for byte. The OpenCode 2 plugin puts the block in its own text part, followed by a blank line; when OpenCode 2 compacts a session, the same block (without the blank line) becomes the compaction summary.

Compressed tool result:

```
[openmem: tool result compressed, <tokens> tokens — smart_compact_get(id="<id>") returns the full text]
<head excerpt>
…
<tail excerpt>
```

The compressed form is a pure function of the original content and the configured thresholds, so the same tool result renders to the same bytes on every request and the prompt-cache prefix stays valid.

`scripts/tests/test_context_parity.mjs` runs the fixture requests in `scripts/tests/fixtures/context-parity.json` through both implementations and requires identical views, session database contents (every `messages` and `lines` column, `sqlite_master`, `user_version`) and blobs. The fixture also holds the golden standing instruction and pointer text, which `STANDING_INSTRUCTION` and `pointer_text` / `pointerText` must reproduce byte for byte.
