# Context store contract

The context proxy, the session hooks, and the `smart_compact_*` MCP tools exchange state through local files. This page is the contract between them; change it before changing any side.

## Location

Root: `$OPENMEM_STATE_DIR/context`, default `~/.local/share/openmem/context`. Directories are mode 700, files mode 600. The context-proxy container bind-mounts this directory read-write and runs as the host UID/GID.

| Path | Writer | Reader | Content |
| --- | --- | --- | --- |
| `sessions/<sid>.json` | SessionStart hook | proxy, MCP | Registration: `{"session_id", "agent", "cwd", "bank", "registered_at"}` (ISO 8601 UTC) |
| `sessions/<sid>.force` | prompt hook on `/smart-compact` | proxy | Empty flag. The proxy trims on the next request for that session, then deletes the flag. |
| `sessions/<sid>.trim.json` | proxy | proxy | Proxy-private trim state (cut point, fingerprints). Other components must not depend on its shape. |
| `sessions/<sid>.log.jsonl` | proxy | MCP `smart_compact_search` | Handoff log: one row per trimmed content block, appended at trim time |
| `blobs/<id>.txt` | proxy | MCP `smart_compact_get` | Full text of a compressed tool result. `id` = first 16 hex chars of SHA-256 of the UTF-8 content. |

`<sid>` is the agent's session id with every character outside `[A-Za-z0-9._-]` replaced by `_`. The proxy reads it, in order, from the `x-openmem-session-id` request header (sent by OpenMem's OpenCode plugin through its `chat.headers` hook), the `x-claude-code-session-id` header (Claude Code; equals the hook `session_id`), then `metadata.user_id` JSON `session_id`. When the proxy cannot find a session id in a request, it uses `fp-<first 16 hex of SHA-256(system prompt + first user message)>`; such sessions have no registration, so recall injection is skipped but trimming still works.

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

Pointer block placed at the start of the first kept user turn after a trim:

```
[openmem: continuing session <sid>; <n> earlier messages trimmed. Use smart_compact_search(session_id="<sid>", query=...) for anything earlier.]
```

Followed, when the registration names a bank and recall succeeds, by `[openmem recall]` and at most `[compaction] max_chars` characters of recalled memory.

Compressed tool result:

```
[openmem: tool result compressed, <tokens> tokens — smart_compact_get(id="<id>") returns the full text]
<head excerpt>
…
<tail excerpt>
```

The compressed form is a pure function of the original content and the configured thresholds, so the same tool result renders to the same bytes on every request and the prompt-cache prefix stays valid.
