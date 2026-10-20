# Coding agents and MCP

The Hindsight client plugin is installed separately, not by this repository:

```sh
npx @vectorize-io/hindsight-coding-agents install claude-code codex opencode cursor-cli \
  --server self-hosted --api-url http://127.0.0.1:8888
```

Or accept the coding-agent step in `personal-memory setup` / `./setup`.

Use a **real** `~/.hindsight/coding-agent.json` on disk (seed from `config/coding-agent.json`). Do not symlink into the repo — machine fields such as `optInPaths` and `notebooklmAccess` must not live in the checkout. The indexer reads this file through the `$HOME` mount. If it is missing, the indexer logs a warning and still indexes everything under `$HOME`.

### Memory MCP servers (`~/.cursor/mcp.json`)

To register **only** memory-related MCP entries (NotebookLM, mem0, Cognee) without re-running full setup:

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
