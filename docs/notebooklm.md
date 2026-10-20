# NotebookLM

Opt-in. Syncs notebooks, sources, notes, and (optionally) chats from Google NotebookLM into Hindsight banks named `notebooklm::<notebook slug>`. Each notebook gets one bank; duplicate titles get an ID suffix. The service runs only under the `notebooklm` compose profile, so `docker compose up` never starts it.

Risks:

- The default `client` backend uses the unofficial `notebooklm-py` library (pinned to 0.8.5 with the `markdown` extra). Google can change or block it at any time, and the sync then fails until the library is updated.
- The stored login is a Google session cookie set. Anyone who reads `~/.config/notebooklm` can act on that Google account. The directory is bind-mounted read-write into the sync container only, and masked from the indexer.
- Source text and notes are copied into the Hindsight banks on this machine, where Hindsight's model server processes them.

Login happens in **`npm run setup`** when you enable NotebookLM: the wizard installs
`notebooklm-py` (via `uv`) if needed, opens the Google sign-in browser, then writes
`NOTEBOOKLM_HOME=~/.config/notebooklm` into the process environment and `wizard.conf`.
Cookies land in `~/.config/notebooklm/profiles/default/storage_state.json` (bind-mounted
into the sync container). Re-run setup when Google expires the session.

Manual equivalent (only if you skip the wizard step):

```sh
mkdir -p ~/.config/notebooklm
uv tool install 'notebooklm-py[browser]==0.8.5'
uv tool run --from 'notebooklm-py[browser]==0.8.5' python -m playwright install chromium
NOTEBOOKLM_HOME=~/.config/notebooklm notebooklm login        # or: ... login --browser-cookies chrome
NOTEBOOKLM_HOME=~/.config/notebooklm notebooklm auth check --test --json
```

Enable and start:

1. Create `~/.config/hindsight/notebooklm.yml` with only the keys you change, for example:

   ```yaml
   enabled: true
   interval_minutes: 60        # default 60
   include_notebooks: ["Work*"] # fnmatch globs, case-insensitive; empty means all
   ```

   Compose refuses to start if this file is missing; create it first (`touch` is enough when there are no changes). Keys merge with `config/notebooklm.yml`; lists and scalars replace the shipped value.
2. Start the service from the repository:

   ```sh
   docker compose --profile notebooklm up -d notebooklm
   docker compose --profile notebooklm logs -f notebooklm
   ```

Without a login, the service logs the login commands and retries every 15 minutes. With `enabled: false` it sleeps and checks again hourly.

### Coding-agent access (`notebooklmAccess`)

Synced notebooks land in Hindsight banks named `notebooklm::<slug>`. The coding-agent plugin still uses per-repo `coding-agent::*` banks only. Agents can **list/search** NotebookLM banks on demand (no auto-inject) via an opt-in MCP.

**Primary paths** (pick one):

1. **Wizard** — when you enable NotebookLM sync in setup (step 6), the wizard asks whether to allow coding agents to query those banks via MCP (`notebooklm_list_banks` / `notebooklm_search`). Default is yes after sync is enabled. On yes it writes `notebooklmAccess.enabled: true` into a **real** `~/.hindsight/coding-agent.json` (if that path was a symlink to the repo template, it is copied to a regular file first so machine settings never land in `config/coding-agent.json`) and merges a `notebooklm` entry into `~/.cursor/mcp.json`.
2. **`npx personal-memory install-mcp`** — same enable + MCP merge when NotebookLM is already on (`notebooklm.yml` `enabled: true`) or with `--notebooklm` / `--notebooklm-only`. See [Coding agents and MCP](coding-agents.md).

Restart Cursor Agent after either path. Manual JSON remains a fallback if you skipped the prompt or need to change allowlists later:

```json
"notebooklmAccess": {
  "enabled": true,
  "banks": ["*"]
}
```

- `enabled: false` (shipped default) — the NotebookLM MCP exits immediately; setup does not register it.
- `banks: ["*"]` — every `notebooklm::*` bank; or list slugs / full ids (e.g. `"sitrep-analysis"` or `"notebooklm::sitrep-analysis"`).

MCP tools (stdio server `cli/notebooklm-mcp.mjs`):

| Tool | Purpose |
| --- | --- |
| `notebooklm_list_banks` | Allowlisted `notebooklm::*` banks (`bank_id`, `fact_count`) |
| `notebooklm_search` | Fast full-text list on one allowlisted bank (`bank_id` + `query`; optional `mode=recall` for slow LLM synthesis) |

When `enabled` is true, the wizard or `install-mcp` merges a `notebooklm` entry into `~/.cursor/mcp.json` (does not overwrite `hindsight` or `codegraph`). To run the server by hand:

```sh
# after enabling notebooklmAccess (wizard, install-mcp, or hand-edit)
node cli/notebooklm-mcp.mjs
# or: personal-memory-notebooklm-mcp
```

Enterprise backend (`backend: enterprise`): the documented NotebookLM Enterprise REST API lists recently viewed notebooks only. It returns no source or note text, so this backend syncs notebook metadata only. It is untested against a live Enterprise project.
