# Coding-agent session hooks (parity)

Hindsight ships session retain/recall/reflect through
[`@vectorize-io/hindsight-coding-agents`](https://www.npmjs.com/package/@vectorize-io/hindsight-coding-agents).
openmem routes session work through the **unified MCP** (`memory_*`) for all three backends.

## Capability matrix

| Capability | Hindsight (default shim) | mem0 (session shim) | Cognee (session shim) |
| --- | --- | --- | --- |
| retain | yes for supported agent transcripts | yes for supported agent transcripts (`memory_add`) | yes for supported agent transcripts |
| recall / search | yes | yes (prompt hook → `memory_recall`) | yes |
| reflect | yes (`memory_reflect` → Hindsight reflect) | search + optional LiteLLM synthesis | search + optional LiteLLM synthesis; raw hits if unavailable |
| consolidate | yes (Hindsight/LiteLLM routes) | no | yes (`memory_consolidate` → cognify) |
| bank / scope | Hindsight banks | mem0 `user_id` | Cognee dataset |

Flags live in `cli/coding-agent/capabilities.mjs`; `doctor wiring` and
`install-coding-agent` read the same table. `npx @bcmyguest/openmem wiring` prints
which session features work for the active provider.

## Install per agent

```sh
npx @bcmyguest/openmem install-coding-agent --yes
```

- **All providers:** unified MCP and [shared skill](../skills/openmem/SKILL.md), plus session hooks (`cli/coding-agent/hook-runner.mjs`) for Claude Code, Codex, Cursor Agent, and a JavaScript OpenCode plugin (`cli/coding-agent/opencode-plugin.mjs`).
- **Exclusive hook sets:** `[agents] integration` in `~/.config/personal-memory/config.toml` picks one. `openmem` (default) installs the hooks above and removes upstream Hindsight hook entries (commands under `hindsight-coding-agents` / `.hindsight/coding-agents`, and the matching OpenCode `plugin` entry). `provider` (`--provider-plugin`, Hindsight only) removes OpenMem's hooks, keeps the unified MCP, and runs `@vectorize-io/hindsight-coding-agents install`. `--no-provider-plugin` switches back; `--hindsight-plugin` is a deprecated alias. Other providers always get OpenMem hooks.

SessionStart output starts with a two-line banner: provider, bank, and the tools to use. It names `memory_pages_search` and `memory_capture_initiative` only when `PROVIDER_CAPABILITIES` marks `knowledge_pages` / `initiatives` for the provider. The same hook writes `sessions/<sid>.json` per [context store](context-store.md); a write failure is ignored. Denied workspaces get no registration.

`/smart-compact`: the installer writes `~/.claude/commands/smart-compact.md`. The prompt hook (Claude Code, Codex, Cursor) and the OpenCode plugin write `sessions/<sid>.force` when the prompt starts with `/smart-compact`, contains `<command-name>/smart-compact</command-name>`, or contains the command body's `openmem:smart-compact` marker; that prompt skips recall. The flag is written even when memory hooks are denied. Claude Code's hook docs say UserPromptSubmit receives the typed `/command args` text; the other two forms cover expanded deliveries.

Cursor hooks live under `hooks` in `~/.cursor/hooks.json` with `version: 1`, as Cursor documents; reinstall moves entries older OpenMem versions wrote at the top level.

See [MCP setup](mcp-setup.md) and [coding agents](coding-agents.md).

Claude Code Stop retention parses ordinary message and tool-use rows. Codex Stop retention is best effort because Codex does not guarantee a stable transcript format. Cursor Stop retention has a bounded adapter for the observed local agent-transcripts JSONL shape (top-level user/assistant role and `message.content` parts). Live Cursor Hook `transcript_path` linkage to that format remains unverified; unknown row shapes are skipped. Cursor recall and explicit `memory_add` remain available. OpenCode retention uses its plugin's session messages API.

Hindsight Stop hooks submit retains with `async: true` so model extraction runs after the hook returns. A successful queue response advances the transcript cursor; later extraction failures must be checked through Hindsight operations. MCP `memory_add` defaults to async; pass `async: false` to wait for extraction.
SessionStart hooks use recall instead of reflect. Hindsight startup recall requests `budget: low` and `max_tokens: 1200`; all hook recall output is limited to eight hits and 8000 characters. Explicit `memory_reflect` remains available through the MCP.

## Session scopes

Indexer banks map to provider scopes (`coding-agent::repo`, `obsidian::vault`, mem0 `user_id`, Cognee dataset names). Default MCP scope key: `openmem-mcp`. See [coding-agent-scopes.md](coding-agent-scopes.md).

Hook access is configured in `~/.config/personal-memory/coding-agent.json`. With no file,
hooks are enabled for all workspaces and use the bank derived from the workspace name. A
malformed or unreadable config denies hook access, as does an event with no workspace path.
Set `disabled: true` to turn hooks off, or set `optInOnly: true` and list allowed absolute
workspace prefixes in `optInPaths`. Project banks resolve in this order: longest matching
prefix in active `index.yml` `banks`, longest matching prefix in this openmem
config, then the legacy Hindsight `~/.hindsight/coding-agent.json` mapping. Without
a match, the literal repository directory name is used in `coding-agent::<name>` (case
preserved). Nested workspace paths resolve to their Git repository root, and linked
worktrees share the common repository identity. The openmem config owns current
access and mapping policy; the legacy mapping remains supported for compatibility.
