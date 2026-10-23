---
name: personal-memory
description: Use this device's shared project memory from Claude Code, Codex, Cursor Agent, or OpenCode. Use when recalling past decisions, storing durable findings, correcting stale memory, or checking which memory provider is active.
---

# Personal memory

The `personal-memory` MCP exposes the same `memory_*` tools to every coding agent. It routes them to the active Hindsight, mem0, or Cognee provider. Session hooks also recall project context and retain supported session transcripts automatically.

## Scope

For project work, pass the project bank explicitly so memories do not land in the MCP default `personal-memory-mcp` scope. Bank resolution uses the longest matching prefix in `index.yml` `banks`, then `~/.config/personal-memory/coding-agent.json` `mapPathToBank`, then the legacy `~/.hindsight/coding-agent.json` mapping. If none matches, it uses `coding-agent::<repository-directory-name>` and preserves the repository name's case. Nested directories resolve to the repository root; linked worktrees use the common repository's identity. Outside a Git repository, the current directory name is used.

## Retrieve

- For past decisions or project context, call `memory_recall` with a focused query and the project bank. `memory_search` is also available for direct search.
- Use `memory_reflect` when a question needs a synthesized answer across several memories. Check the returned evidence before treating it as current truth.
- If the tools are unavailable, say that memory was unavailable. Do not claim to have searched it.

## Store and correct

- Session hooks capture supported conversations. When the user explicitly asks to remember a durable fact, external note, or decision now, call `memory_add` with a concise, self-contained record and the project bank.
- When verified code or current documentation contradicts a memory, call `memory_add` with a correction that states the old claim, the current fact, and the evidence. Do not silently leave a known false record to resurface.
- `memory_forget` can delete an entire Hindsight bank. Confirm the exact scope before using it for bulk deletion.

Use `memory_provider_status` to identify the active provider when that matters. The provider can change without changing this skill or the tool names.
# Project scope inspection

Use the `memory_project_scope` MCP tool to inspect which bank a workspace resolves to and whether coding-agent session access is permitted. It accepts an absolute `cwd` and defaults to the MCP server's current working directory. The result reports the active `index.yml` bank mapping and personal-memory `mapPathToBank`; it is local and read-only and does not query a memory provider.
