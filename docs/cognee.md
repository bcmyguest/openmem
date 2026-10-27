# Cognee (loopback container)

Self-hosted graph/RAG memory via a pinned `cognee/cognee` image on a loopback port (`COGNEE_PORT`, default **8766**). Auth is off in this stack. Cognify defaults to local GLiNER + FastEmbed (no API key); optional LLM keys live in env files under `~/.config/personal-memory/`, not in stack `.env` or `mcp.json`.

## Coding agents

No plugin package. Agents use REST (`/docs`, `/health`, `/api/v1/add`, `/cognify`, `/search`) or the **read-only** MCP in this repo.

### Cursor MCP

When `MEMORY_PROVIDER=cognee`:

```sh
npx personal-memory install-mcp --yes --provider-only
```

Registers `cli/cognee-mcp.mjs` with `COGNEE_API_URL` only — **never** `COGNEE_API_KEY` in `mcp.json`. If you enable auth, export the key in the agent environment.

| Tool | Purpose |
| --- | --- |
| `cognee_health` | `GET /health` |
| `cognee_search` | `POST /api/v1/search` |

Ingest and cognify stay with the indexer or direct API calls; the MCP is search/health only.

Restart Cursor Agent after install.

## Switch provider

```sh
npx personal-memory switch cognee --yes
# later: npx personal-memory switch hindsight --yes
```

Updates active provider config, restarts the stack (unless `--no-stack`), runs MCP install (unless `--no-mcp`). Does **not** migrate memories.

See also [Architecture](architecture.md), [Hindsight](hindsight.md), and [Provider status](https://bcmyguest.github.io/personal-memory/docs/provider-status/).
