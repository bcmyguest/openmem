# Context store contract

The context proxy, OpenMem's OpenCode 2 plugin (which trims natively instead of using the proxy), the session hooks, and the `smart_compact_*` MCP tools exchange state through local files. Below, "proxy" means whichever of the two trims a session. This page is the contract between them; change it before changing any side.

## Location

Root: `$OPENMEM_STATE_DIR/context`, default `~/.local/share/openmem/context`. Surrounding ASCII whitespace (space, `\t`, `\n`, `\v`, `\f`, `\r`) is trimmed from `OPENMEM_STATE_DIR`; an empty value after trimming means the default. Directories are mode 700, files mode 600. The context-proxy container bind-mounts this directory read-write and runs as the host UID/GID.

| Path | Writer | Reader | Content |
| --- | --- | --- | --- |
| `sessions/<sid>.json` | SessionStart hook, OpenCode plugins | proxy, MCP | Registration: `{"session_id", "agent", "cwd", "bank", "registered_at"}` (ISO 8601 UTC) |
| `sessions/<sid>.force` | prompt hook or OpenCode plugin on `/smart-compact` | proxy | Empty flag. The proxy trims on the next request for that session, then deletes the flag. |
| `sessions/<sid>.trim.json` | proxy | proxy | Proxy-private trim state (cut point, fingerprints). Other components must not depend on its shape. |
| `sessions/<sid>.log.jsonl` | proxy | MCP `smart_compact_search`, shell tools | Handoff log: one row per trimmed content block, appended at trim time |
| `blobs/<id>.txt` | proxy | MCP `smart_compact_get` | Full text of a compressed tool result. `id` = first 16 hex chars of SHA-256 of the UTF-8 content. |

## Session id

`<sid>` is the agent's session id after this rule, applied identically by the hooks and plugins (`sanitizeSessionId` in `cli/coding-agent/context-store.mjs`), the proxy (`sanitize_sid` in `proxy/openmem_context/store.py`) and the MCP tools:

1. Trim surrounding ASCII whitespace (space, `\t`, `\n`, `\v`, `\f`, `\r`); other whitespace is not trimmed.
2. Replace every Unicode code point outside `[A-Za-z0-9._-]` with one `_` (`😀` becomes `_`, not `__`).
3. Reject an empty result: hooks write no file, the proxy tries the next source below, the MCP tools return an error.

Dots are kept, so `..` survives (`ses/../x` becomes `ses_.._x`). That is safe because step 2 removes every path separator and each file name appends a suffix (`.json`, `.log.jsonl`, ...), so no sid names a path outside `sessions/`. Registration and trimming accept such ids. The MCP tools additionally reject an explicit `session_id` argument containing `/`, `\` or `..` before sanitizing, so a search for a raw id with those characters fails instead of matching the sanitized file.

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

The cut is the last real user turn after the previous cut whose kept part (the suffix plus the pinned first turn) shares no tool call/result pair with the dropped part. No cut exists, and the request passes unchanged, when nothing but pinned messages and the first user turn precede it; in particular, nothing changes while the first user turn is still the in-flight turn. The pinned first turn is never written to the handoff log by a trim, and the pointer's `<n>` excludes it. An OpenCode 2 compaction drops it too, so the compaction logs it then, once, after the rows earlier trims logged.

## Handoff log row

```json
{"seq": 12, "ts": "2026-10-29T17:00:00Z", "role": "assistant", "kind": "tool_use", "name": "Bash", "text": "git status"}
```

| Field | Values |
| --- | --- |
| `seq` | Monotonic per session, starting at 0, never reused |
| `role` | `user` · `assistant` · `tool` |
| `kind` | `text` · `tool_use` · `tool_result` · `thinking` (thinking rows carry summary text only, never signatures) |
| `name` | Tool name for `tool_use` / `tool_result`, else `null` |
| `text` | Plain text; tool inputs as compact JSON; compressed tool results reference their blob as `[blob:<id>]` |

## Proxy-inserted text

Pointer block placed at the start of the cut turn after a trim:

```
[openmem: continuing session <sid>; <n> earlier messages trimmed. Use smart_compact_search(session_id="<sid>", query=...) for anything earlier; the handoff log is <log path> (JSONL, one row per block).]
```

`<log path>` is `sessions/<sid>.log.jsonl` under the context root as the agent sees it, so an agent with a shell can `rg` it. The OpenCode 2 plugin runs on the host and names its own path. The proxy runs in a container where the root is `/state/context`, so it names `$OPENMEM_HOST_STATE_DIR/context/sessions/<sid>.log.jsonl` when `OPENMEM_HOST_STATE_DIR` is set (the host value of `OPENMEM_STATE_DIR`), else its own path.

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

`scripts/tests/test_context_parity.mjs` runs the fixture requests in `scripts/tests/fixtures/context-parity.json` through both implementations and requires identical views, log rows and blobs.
