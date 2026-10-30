# Coding agents and MCP

Prerequisite: run the wizard (`npx @bcmyguest/openmem`) so a provider stack is up. The MCP server and hooks only forward to that stack. Per-agent support and evidence levels: [Compatibility matrix](compatibility.md).

One entry point for session wiring on **every** provider (unified MCP + in-repo session hooks):

```sh
npx @bcmyguest/openmem install-coding-agent --yes
# --provider-plugin / --no-provider-plugin: upstream Hindsight hooks instead of openmem's (saved in config)
# --no-rtk: skip rtk wiring;  --context-proxy / --no-context-proxy: local context proxy (saved in config)
# same flags: --dry-run, --agents claude-code,codex,opencode,cursor-cli,hermes,gemini-cli,amp,cline
```

Persisted choices live in `~/.config/personal-memory/config.toml`:

| Table | Key | Default | Flag |
| --- | --- | --- | --- |
| `[agents]` | `integration` = `openmem` \| `provider` | `openmem` | `--provider-plugin`, `--no-provider-plugin` |
| `[context_proxy]` | `enabled` | `false` | `--context-proxy`, `--no-context-proxy` |
| `[context_proxy]` | `port` | `4100` | edit the file |
| `[compaction]` | `native` | `true` | edit the file; OpenCode 2 only (see below) |

The two hook sets are exclusive; see [hook parity](coding-agent-hooks.md#install-per-agent).

**rtk.** When [`rtk`](https://github.com/rtk-ai/rtk) is on `PATH`, the installer runs rtk's own setup per selected agent: `rtk init -g --auto-patch` (Claude Code), `rtk init -g --codex`, `rtk init -g --agent cursor`, `rtk init -g --opencode`. rtk adds PreToolUse-style command rewriting and keeps other hooks; OpenMem's reinstall keeps rtk's entries. `rtk init` is idempotent. `--no-rtk` skips it.

**Context proxy.** `--context-proxy` creates `~/.config/personal-memory/context-proxy.env` (mode 600) with `LITELLM_MASTER_KEY` once and reuses it. Claude Code gets `env.ANTHROPIC_BASE_URL = http://127.0.0.1:<port>` and `env.ANTHROPIC_CUSTOM_HEADERS = x-litellm-api-key: Bearer <key>` in `~/.claude/settings.json`; OpenCode gets `provider.anthropic.options.baseURL = http://127.0.0.1:<port>/v1` and the same header ([OpenCode providers](https://opencode.ai/docs/providers/#base-url)). Claude Code then fails until the proxy runs. The proxy trims long sessions and compresses tool results; typing `/smart-compact` makes the prompt hook flag the next request for a trim. See [Context proxy](context-proxy.md). `--no-context-proxy` removes those keys when they still point at the loopback proxy; the key file stays. Codex stays hook-only. OpenCode 2 is never pointed at the proxy, even with `--context-proxy`; see below.

**OpenCode 1 or 2.** The installer runs `opencode --version`; output naming major 2 or later (OpenCode 2.2.1 prints `opencode v2.2.1`) selects OpenCode 2, and any failure or other output selects OpenCode 1. OpenCode 1 gets the file entry `cli/coding-agent/opencode-plugin.mjs` under `"plugin"`. OpenCode 2 gets the runtime directory `cli/coding-agent/opencode2-plugin` under `"plugins"` ([OpenCode 2 plugin config](https://opencode.ai/v2/docs/plugins/); configured local paths must be directories). Each install removes OpenMem's entry of the other shape, so only one OpenMem plugin loads. On OpenCode 2 the plugin trims context itself in its `context` hook, with the proxy's rules, thresholds (`CONTEXT_TRIM_AT_TOKENS`, `CONTEXT_COMPRESS_OVER_TOKENS`, `CONTEXT_COMPACTION_MAX_CHARS`, read from the environment OpenCode runs in), standing system-prompt instruction (`CONTEXT_STANDING_INSTRUCTION`) and [context store](context-store.md) files: every message goes into the session database `sessions/<sid>.db` through `node:sqlite` (Node ≥ 22.16). The installer therefore removes any earlier `provider.anthropic` proxy settings and says so in its summary. When OpenCode 2 compacts a session itself, the plugin's `compaction` hook marks every stored message out of context and supplies the `smart_compact_search` pointer plus bounded recall as the summary, so no model call is made. `[compaction] native = false` returns compaction to OpenCode's own summary.

This stages a persistent runtime under `~/.local/share/personal-memory/agent-runtime`, registers the unified MCP globally in Claude Code, Codex, Cursor Agent, and OpenCode, and installs their session hooks. It also copies the [openmem skill](../.agents/skills/openmem/SKILL.md) into each agent's global skill directory. The runtime path stays valid after an `npx` cache cleanup. Re-run the command after upgrading this package to refresh the runtime and skill. See [hook parity](coding-agent-hooks.md).

For Codex, installation enables `features.hooks` when unset and preserves an explicit `false`. For OpenCode, the plugin and MCP entry go into the existing `opencode.jsonc` or `opencode.json`; unrelated settings and JSONC comments outside the updated fields are retained.

Codex requires review of new or changed non-managed hooks in `/hooks` before they run. [Codex hook documentation](https://developers.openai.com/codex/hooks) describes this trust step.

The command keeps existing agent settings and other MCP servers. With `integration = "openmem"` it removes what the upstream Hindsight plugin installed: its hook entries, its `hindsight` MCP server (`~/.claude.json`, `~/.codex/config.toml`, `~/.cursor/mcp.json`) and its `hindsight-coding-agent` skill (`~/.claude/skills`, `~/.agents/skills`, `~/.cursor/skills`). An MCP entry goes only when it runs the upstream `hindsight-coding-agents/dist/mcp-server.js`; a skill only when its `SKILL.md` declares `name: hindsight-coding-agent`. A `hindsight` MCP entry of your own that points elsewhere stays. `--dry-run` lists the removals; `provider` mode removes none of these.

Wizard step 8 (Coding agents) offers the same `install-coding-agent --yes` for detected CLIs.

Use a **real** `~/.hindsight/coding-agent.json` on disk (seed from `config/coding-agent.json`). Do not symlink into the repo — machine fields such as `optInPaths` and `notebooklmAccess` must not live in the checkout. The indexer reads this file through the `$HOME` mount. If it is missing, the indexer logs a warning and still indexes everything under `$HOME`.

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

Restart the Cursor Agent (or other coding agent) after install so it loads the new wiring. With `optInOnly: true`, only paths listed in `optInPaths` get memory — `/tmp` workspaces and other unlisted directories stay opted out.

### Switch memory provider

To change `MEMORY_PROVIDER` (updates `~/.config/hindsight/wizard.conf`, optionally restarts the stack and refreshes provider MCP) without a full interactive setup:

```sh
npx @bcmyguest/openmem switch mem0 --yes
# checkout: node cli/openmem.mjs switch cognee --yes
```

Flags: `--dry-run`, `--no-stack` (skip compose down/up), `--no-mcp` (skip `install-mcp --provider-only`). Switching does **not** migrate memories between backends. After a switch: restart Cursor Agent, then `npx @bcmyguest/openmem doctor`.
