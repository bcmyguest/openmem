---
name: openmem
description: Use this device's shared project memory from Claude Code, Codex, Cursor Agent, or OpenCode. Use when recalling past decisions, storing durable findings, correcting stale memory, or checking which memory provider is active.
---

# OpenMem

The `openmem` MCP exposes the same `memory_*` tools to every coding agent. It routes them to the active Hindsight, mem0, or Cognee provider. Session hooks also recall project context and retain supported session transcripts automatically.

## Scope

For project work, pass the project bank explicitly so memories do not land in the MCP default `openmem-mcp` scope. Bank resolution uses the longest matching prefix in `index.yml` `banks`, then `~/.config/personal-memory/coding-agent.json` `mapPathToBank`, then the legacy `~/.hindsight/coding-agent.json` mapping. If none matches, it uses `coding-agent::<repository-directory-name>` and preserves the repository name's case. Nested directories resolve to the repository root; linked worktrees use the common repository's identity. Outside a Git repository, the current directory name is used.

## Retrieve

- For past decisions or project context, call `memory_recall` with a focused query and the project bank. `memory_search` is also available for direct search.
- Use `memory_reflect` when a question needs a synthesized answer across several memories. Check the returned evidence before treating it as current truth.
- Before fixing a bug or changing a convention, call `memory_pages_search` (then `memory_pages_read`; `memory_pages_list` shows what exists) for curated decision and convention pages. Hindsight only.
- When an `[openmem: continuing session <sid>; …]` pointer says earlier messages are not in your context, call `smart_compact_search` with that `session_id` and a query to recover the detail. Pass `pattern` (a JavaScript regex, `ignore_case` optional) instead of `query` for exact strings, and `context` (0–5) for neighbouring rows; `role` defaults to user and tool rows (`"all"` adds assistant text) and `in_context: false` keeps only trimmed rows; `line_matches` is an exact count of matching lines across the whole session (use it for "how many" questions). For counts, groupings or joins, call `smart_compact_sql` with the `session_id` and one read-only `SELECT` over the session database (`messages`, `lines`, `messages_fts`, `lines_fts`; the tool description lists the schema). For a compressed tool result, call `smart_compact_get` with its `id` (page with `offset`). All three read local files and work with every provider.
- If the tools are unavailable, say that memory was unavailable. Do not claim to have searched it.

## Store and correct

- Session hooks capture supported conversations. When the user explicitly asks to remember a durable fact, external note, or decision now, call `memory_add` with a concise, self-contained record and the project bank. On Hindsight, `memory_add` defaults to **async** ingest (omit `async` or pass `async: true`) so MCP clients do not time out; use `async: false` only when you must wait for extraction.
- When verified code or current documentation contradicts a memory, call `memory_add` with a correction that states the old claim, the current fact, and the evidence. Do not silently leave a known false record to resurface.
- After the user approves a plan for a new feature, call `memory_capture_initiative` before writing code; skip bug fixes and small tweaks.
- Call `memory_status` before relying on recall of just-stored content; it reports whether async ingest has drained.
- `memory_forget` can delete an entire Hindsight bank. Confirm the exact scope before using it for bulk deletion.

Use `memory_provider_status` to identify the active provider when that matters. The provider can change without changing this skill or the tool names.
# Project scope inspection

Use the `memory_project_scope` MCP tool to inspect which bank a workspace resolves to and whether coding-agent session access is permitted. It accepts an absolute `cwd` and defaults to the MCP server's current working directory. The result reports the active `index.yml` bank mapping and openmem `mapPathToBank`; it is local and read-only and does not query a memory provider.
