# Personal-memory repository

The `install-coding-agent` command in `cli/install-coding-agent.mjs` installs the shared skill in `skills/personal-memory/SKILL.md`, the unified `memory_*` MCP, and session hooks. Agent runtime files are copied to `~/.local/share/personal-memory/agent-runtime` so installed paths survive `npx` cache cleanup.

`install-mcp` by itself configures Cursor's MCP file. `install-coding-agent` wires Claude Code, Codex, Cursor Agent, and OpenCode. The upstream Hindsight plugin is optional (`--hindsight-plugin`). See [docs/coding-agents.md](docs/coding-agents.md) for current setup and [docs/coding-agent-hooks.md](docs/coding-agent-hooks.md) for provider capabilities.

The installer sets Codex `features.hooks = true` only when that setting is absent and writes both OpenCode entries to the existing JSONC or JSON config. Hook access uses `~/.config/personal-memory/coding-agent.json`; a missing file permits all absolute workspace paths, while malformed config or missing workspace paths deny hook calls.

Cursor Agent Stop retention parses the observed local `agent-transcripts` JSONL shape; live hook `transcript_path` linkage still needs verification. Codex Stop retention is best effort against an unstable format. `REVAMP.md` tracks the remaining parity and live-verification work.

`memory_export`/`memory_import` use the PMM beta format. JSONL export has one header line and record lines; import accepts that layout. Export still buffers all records, so bank filtering matters for large migrations. See [docs/memory-portability.md](docs/memory-portability.md).
