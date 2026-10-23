# Coding agents and MCP

One entry point for session wiring on **every** provider (unified MCP + in-repo session hooks):

```sh
npx personal-memory install-coding-agent --yes
# optional: --hindsight-plugin (also run @vectorize-io/hindsight-coding-agents on Hindsight stacks)
# same flags: --dry-run, --agents claude-code,codex,opencode,cursor-cli,hermes,gemini-cli,amp,cline
```

This stages a persistent runtime under `~/.local/share/personal-memory/agent-runtime`, registers the unified MCP globally in Claude Code, Codex, Cursor Agent, and OpenCode, and installs their session hooks. It also copies the [personal-memory skill](../skills/personal-memory/SKILL.md) into each agent's global skill directory. The runtime path stays valid after an `npx` cache cleanup. Re-run the command after upgrading this package to refresh the runtime and skill. See [hook parity](coding-agent-hooks.md).

For Codex, installation enables `features.hooks` when unset and preserves an explicit `false`. For OpenCode, the plugin and MCP entry go into the existing `opencode.jsonc` or `opencode.json`; unrelated settings and JSONC comments outside the updated fields are retained.

Codex requires review of new or changed non-managed hooks in `/hooks` before they run. [Codex hook documentation](https://developers.openai.com/codex/hooks) describes this trust step.

The command keeps existing agent settings and other MCP servers. It does not remove the optional Hindsight plugin; after checking the new MCP and hooks, remove the old plugin through its own uninstaller if you no longer want both integrations running.

The wizard coding-agent step follows the same idea for Hindsight-first flows.

Use a **real** `~/.hindsight/coding-agent.json` on disk (seed from `config/coding-agent.json`). Do not symlink into the repo — machine fields such as `optInPaths` and `notebooklmAccess` must not live in the checkout. The indexer reads this file through the `$HOME` mount. If it is missing, the indexer logs a warning and still indexes everything under `$HOME`.

### Memory MCP servers (`~/.cursor/mcp.json`)

To register **only** Cursor's memory-related MCP entries (NotebookLM, mem0, Cognee, and unified `personal-memory`) without re-running full setup:

```sh
npx personal-memory install-mcp --yes
# checkout: npx . install-mcp --yes

# mem0 self-hosted REST → @yeyuan98/mem0-mcp via cli/mem0-mcp.mjs
MEMORY_PROVIDER=mem0 npx personal-memory install-mcp --yes --provider-only

# Cognee read-only health/search → cli/cognee-mcp.mjs
MEMORY_PROVIDER=cognee npx personal-memory install-mcp --yes --provider-only
```

Provider comes from `MEMORY_PROVIDER`, else `~/.config/hindsight/wizard.conf`, else `hindsight`. NotebookLM MCP is installed when `~/.config/hindsight/notebooklm.yml` has `enabled: true`, or with `--notebooklm`. Flags: `--dry-run`, `--notebooklm-only`, `--provider-only`. Existing `hindsight` / `codegraph` / `notebooklm` / sibling provider entries are merged, not clobbered. For mem0, `mcp.json` gets `MEM0_API_URL` / `MEM0_BASE_URL` and the path to `mem0.env` — never the API key ([mem0 operator guide](https://github.com/bcmyguest/personal-memory/blob/main/providers/mem0/OPERATOR.md)). For Cognee, `mcp.json` gets `COGNEE_API_URL` only — never `COGNEE_API_KEY` ([Cognee operator guide](https://github.com/bcmyguest/personal-memory/blob/main/providers/cognee/OPERATOR.md); tools `cognee_health` / `cognee_search`). Manual JSON edits remain a fallback.

Restart the Cursor Agent (or other coding agent) after install so it loads the new wiring. With `optInOnly: true`, only paths listed in `optInPaths` get memory — `/tmp` workspaces and other unlisted directories stay opted out.

### Switch memory provider

To change `MEMORY_PROVIDER` (updates `~/.config/hindsight/wizard.conf`, optionally restarts the stack and refreshes provider MCP) without a full interactive setup:

```sh
npx personal-memory switch mem0 --yes
# checkout: npx . switch cognee --yes
```

Flags: `--dry-run`, `--no-stack` (skip compose down/up), `--no-mcp` (skip `install-mcp --provider-only`). Switching does **not** migrate memories between backends. After a switch: restart Cursor Agent, then `npx personal-memory doctor`.
