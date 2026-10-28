# Personal-memory repository

`openmem schedule install|remove` manages hourly feed sync through the current user's native scheduler (systemd, launchd, or Windows Task Scheduler). The generated runner lives outside the ephemeral npx cache and runs the published npm package. Run `schedule install` through npx so it can record absolute Node/npm paths; it also records a Python 3 interpreter with PyYAML. `cli/feed-sync.mjs` resolves Python 3 (`py -3` on Windows; `python3` on Unix). See [docs/sources-feeds.md](docs/sources-feeds.md).

The README has a short data-flow diagram; [docs/architecture.md](docs/architecture.md) holds the full one. [Provider status](https://bcmyguest.github.io/openmem/docs/provider-status/) is generated from `providers/*/manifest.json` and is the public source for support claims. In docs, “provider” names the selected memory system; `providers/<id>/` contains OpenMem's adapter.

The `install-coding-agent` command in `cli/install-coding-agent.mjs` installs the shared skill in `.agents/skills/openmem/SKILL.md`, the unified `memory_*` MCP, and session hooks. Agent runtime files are copied to `~/.local/share/personal-memory/agent-runtime` so installed paths survive `npx` cache cleanup.
Re-run `install-coding-agent --yes` after changing hook code; installed agents run the copied runtime, not this checkout. The current bank resolver keeps the repository name's case and follows the indexer's bank mapping.
Hindsight Stop hooks submit transcript retention asynchronously to the server, then checkpoint the transcript cursor after the queue accepts it. MCP `memory_add` defaults to async ingest; use `async: false` when you need to wait for extraction.
SessionStart hooks use bounded recall (`budget: low`, `max_tokens: 1200` on Hindsight) so startup does not wait for model-backed reflect. Hook recall context is capped at 8000 characters.

`install-mcp` by itself configures Cursor's MCP file. `install-coding-agent` wires Claude Code, Codex, Cursor Agent, and OpenCode. The upstream Hindsight plugin is optional (`--hindsight-plugin`). See [docs/coding-agents.md](docs/coding-agents.md) for current setup and [docs/coding-agent-hooks.md](docs/coding-agent-hooks.md) for provider capabilities.

The installer sets Codex `features.hooks = true` only when that setting is absent and writes both OpenCode entries to the existing JSONC or JSON config. Hook access uses `~/.config/personal-memory/coding-agent.json`; a missing file permits all absolute workspace paths, while malformed config or missing workspace paths deny hook calls.

Cursor Agent Stop retention parses the observed local `agent-transcripts` JSONL shape; live hook `transcript_path` linkage still needs verification. Codex Stop retention is best effort against an unstable format. `REVAMP.md` tracks the remaining parity and live-verification work.

`memory_export`/`memory_import` use the PMM beta format. JSONL export has one header line and record lines; import accepts that layout. Export still buffers all records, so bank filtering matters for large migrations. See [docs/memory-portability.md](docs/memory-portability.md).
