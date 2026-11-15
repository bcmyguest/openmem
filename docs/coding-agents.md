# Coding agents and MCP

> **Context management:** OpenMem 0.10 removed its context proxy and trim plugin. Use **[Smarter Compact](https://github.com/bcmyguest/smarter-compact)** for trimming long sessions.

Prerequisite: run the wizard (`npx @bcmyguest/openmem setup`) so a provider stack is up. The MCP server and hooks only forward to that stack. Per-agent support and evidence levels: [Compatibility matrix](compatibility.md).

One entry point for session wiring on **every** provider (unified MCP + in-repo session hooks):

```sh
npx @bcmyguest/openmem install-coding-agent --yes
# --provider-plugin / --no-provider-plugin: upstream Hindsight hooks instead of openmem's (saved in config)
# --no-rtk: skip rtk wiring
# same flags: --dry-run, --agents claude-code,codex,opencode,cursor-cli,hermes,gemini-cli,amp,cline
```

Persisted choices live in `~/.config/personal-memory/config.toml`:

| Table | Key | Default | Flag |
| --- | --- | --- | --- |
| `[agents]` | `integration` = `openmem` \| `provider` | `openmem` | `--provider-plugin`, `--no-provider-plugin` |

The two hook sets are exclusive; see [hook parity](coding-agent-hooks.md#install-per-agent).

**rtk.** When [`rtk`](https://github.com/rtk-ai/rtk) is on `PATH`, the installer runs rtk's own setup per selected agent: `rtk init -g --auto-patch` (Claude Code), `rtk init -g --codex`, `rtk init -g --agent cursor`, `rtk init -g --opencode`. rtk adds PreToolUse-style command rewriting and keeps other hooks; OpenMem's reinstall keeps rtk's entries. `rtk init` is idempotent. `--no-rtk` skips it.

**Settings from openmem 0.9 and earlier.** The installer never edits `ANTHROPIC_BASE_URL`, OpenCode provider settings or Codex `model_provider`; [Smarter Compact](https://github.com/bcmyguest/smarter-compact) may own them. When one still points at openmem's removed proxy (the `[context_proxy] port`, else 4100, or Codex `model_provider = "openmem"`), the installer prints the setting and the manual fix (`cli/coding-agent/legacy-context-proxy.mjs`).

**OpenCode 1 or 2.** The installer runs `opencode --version`; output naming major 2 or later (OpenCode 2.2.1 prints `opencode v2.2.1`) selects OpenCode 2, and any failure or other output selects OpenCode 1. OpenCode 1 gets the file entry `cli/coding-agent/opencode-plugin.mjs` under `"plugin"`. OpenCode 2 gets the runtime directory `cli/coding-agent/opencode2-plugin` under `"plugins"` ([OpenCode 2 plugin config](https://opencode.ai/v2/docs/plugins/); configured local paths must be directories). Each install removes OpenMem's entry of the other shape, so only one OpenMem plugin loads.

This stages a persistent runtime under `~/.local/share/personal-memory/agent-runtime`, registers the unified MCP globally in Claude Code, Codex, Cursor Agent, and OpenCode, and installs their session hooks. It also copies the [openmem skill](../.agents/skills/openmem/SKILL.md) into each agent's global skill directory. The runtime path stays valid after an `npx` cache cleanup. Re-run the command after upgrading this package to refresh the runtime and skill. See [hook parity](coding-agent-hooks.md).

For Codex, installation sets `sandbox_mode = "workspace-write"` and enables `features.hooks` and `sandbox_workspace_write.network_access` when unset, and preserves explicit values. Codex otherwise defaults to a read-only sandbox without network, which breaks `curl` and package installs. For OpenCode, the plugin and MCP entry go into the existing `opencode.jsonc` or `opencode.json`; unrelated settings and JSONC comments outside the updated fields are retained.

Codex requires review of new or changed non-managed hooks in `/hooks` before they run. [Codex hook documentation](https://developers.openai.com/codex/hooks) describes this trust step.

The command keeps existing agent settings and other MCP servers. With `integration = "openmem"` it removes what the upstream Hindsight plugin installed: its hook entries, its `hindsight` MCP server (`~/.claude.json`, `~/.codex/config.toml`, `~/.cursor/mcp.json`) and its `hindsight-coding-agent` skill (`~/.claude/skills`, `~/.agents/skills`, `~/.cursor/skills`). An MCP entry goes only when it runs the upstream `hindsight-coding-agents/dist/mcp-server.js`; a skill only when its `SKILL.md` declares `name: hindsight-coding-agent`. A `hindsight` MCP entry of your own that points elsewhere stays. `--dry-run` lists the removals; `provider` mode removes none of these.

Wizard step 8 (Coding agents) offers the same `install-coding-agent --yes` for detected CLIs.

Two config files, different jobs:

| File | Who reads it |
| --- | --- |
| `~/.config/personal-memory/coding-agent.json` | Hooks / session memory (`optInOnly`, `optInPaths`, `mapPathToBank`, `disabled`) |
| `~/.hindsight/coding-agent.json` | Indexer source filter (`optInPaths`) plus Hindsight-only fields such as `notebooklmAccess` |

`install-coding-agent` and the Hindsight wizard seed or sync the openmem file from the legacy Hindsight file when present (`ensureAccessConfig` / `syncAccessPolicyFromLegacy`). Keep `~/.hindsight/coding-agent.json` as a **real file** on disk (seed from `config/coding-agent.json`); do not symlink it into the repo. The indexer reads it through the `$HOME` mount. If that legacy file is missing, the indexer logs a warning and still indexes everything under `$HOME`.

### Memory MCP servers (`~/.cursor/mcp.json`)

To register **only** Cursor's memory-related MCP entries (NotebookLM, mem0, Cognee, and unified `openmem`) without re-running full setup:

```sh
npx @bcmyguest/openmem install-mcp --yes
# checkout: node cli/openmem.mjs install-mcp --yes

# mem0 self-hosted REST → @yeyuan98/mem0-mcp via cli/mem0-mcp.mjs
MEMORY_PROVIDER=mem0 npx @bcmyguest/openmem install-mcp --yes --provider-only

# Cognee read-only health/search → cli/cognee-mcp.mjs
MEMORY_PROVIDER=cognee npx @bcmyguest/openmem install-mcp --yes --provider-only
```

Provider comes from `MEMORY_PROVIDER`, else `~/.config/hindsight/wizard.conf`, else `hindsight`. NotebookLM MCP is installed when `~/.config/hindsight/notebooklm.yml` has `enabled: true`, or with `--notebooklm`. Flags: `--dry-run`, `--notebooklm-only`, `--provider-only`. Existing `hindsight` / `codegraph` / `notebooklm` / sibling provider entries are merged, not clobbered. For mem0, `mcp.json` gets `MEM0_API_URL` / `MEM0_BASE_URL` and the path to `mem0.env` — never the API key ([mem0 operator guide](https://github.com/bcmyguest/openmem/blob/main/providers/mem0/OPERATOR.md)). For Cognee, `mcp.json` gets `COGNEE_API_URL` only — never `COGNEE_API_KEY` ([Cognee operator guide](https://github.com/bcmyguest/openmem/blob/main/providers/cognee/OPERATOR.md); tools `cognee_health` / `cognee_search`). Manual JSON edits remain a fallback.

Restart the Cursor Agent (or other coding agent) after install so it loads the new wiring. Hook / session memory honour `optInOnly` / `optInPaths` in `~/.config/personal-memory/coding-agent.json` (missing file = all workspaces allowed). Indexer source filtering still uses `optInPaths` in `~/.hindsight/coding-agent.json`.

### Switch memory provider

To change `MEMORY_PROVIDER` (updates `~/.config/hindsight/wizard.conf`, optionally restarts the stack and refreshes provider MCP) without a full interactive setup:

```sh
npx @bcmyguest/openmem switch mem0 --yes
# checkout: node cli/openmem.mjs switch cognee --yes
```

Flags: `--dry-run`, `--no-stack` (skip compose down/up), `--no-mcp` (skip `install-mcp --provider-only`). Switching does **not** migrate memories between backends. After a switch: restart Cursor Agent, then `npx @bcmyguest/openmem doctor`.
