# Cognee operator notes

Self-hosted graph/RAG memory via a pinned `cognee/cognee` image on a loopback
port (`COGNEE_PORT`, default **8766**). Auth is off in this stack. Secrets
(`LLM_API_KEY`, optional `COGNEE_API_KEY`) live in env files under
`~/.config/personal-memory/`, never in the stack `.env`, `wizard.conf`, or
`mcp.json`.

See also [docs/memory-providers.md](../../docs/memory-providers.md) and
[docs/personal-memory-config.md](../../docs/personal-memory-config.md).

## Coding agents (no plugin package)

Agents use the REST API (`/docs`, `/health`, `/api/v1/add`, `/cognify`, `/search`)
or the **read-only** stdio MCP shipped in this repo.

### Cursor MCP (`~/.cursor/mcp.json`)

When `MEMORY_PROVIDER=cognee`:

```sh
npx personal-memory install-mcp --yes --provider-only
# checkout: npx . install-mcp --yes --provider-only
# or during setup: coding-agent step registers the same entry
```

That merges a `cognee` server pointing at `cli/cognee-mcp.mjs` with
`env.COGNEE_API_URL` only (host URL; **never** `COGNEE_API_KEY`). Existing
`hindsight` / `codegraph` / `notebooklm` / `mem0` entries are left alone.

| Tool | Purpose |
| --- | --- |
| `cognee_health` | `GET /health` |
| `cognee_search` | `POST /api/v1/search` (`query`, optional `searchType`, `datasets`) |

Run by hand:

```sh
node cli/cognee-mcp.mjs
# or: personal-memory-cognee-mcp
```

Base URL resolution inside the MCP: `COGNEE_API_URL` / `COGNEE_URL`, else
`http://127.0.0.1:${COGNEE_PORT|8766}`. If you enable auth in compose, export
`COGNEE_API_KEY` in the agent environment (not in `mcp.json`).

v1 MCP is read-only (no add/cognify). Ingest stays with the indexer or curl.

### Switch to / from Cognee

```sh
npx personal-memory switch cognee --yes
# later: npx personal-memory switch hindsight --yes
# checkout: npx . switch cognee --yes
```

Updates `wizard.conf` (and `config.toml` `[memory].provider` when present), restarts the stack
unless `--no-stack`, and runs `install-mcp --provider-only` unless `--no-mcp`. Does **not**
migrate memories. Flags: [README — Switch memory provider](../../README.md#switch-memory-provider).
