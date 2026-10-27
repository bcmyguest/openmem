# Cognee operator notes

Self-hosted graph/RAG memory via a pinned `cognee/cognee` image on a loopback
port (`COGNEE_PORT`, default **8766**). Auth is off in this stack. Cognify
defaults to **local GLiNER + FastEmbed** (no API key). Optional secrets
(`LLM_API_KEY` for OpenAI/Ollama paths, `COGNEE_API_KEY` if you enable auth)
live in env files under `~/.config/personal-memory/`, never in the stack
`.env`, `wizard.conf`, or `mcp.json`.

See also [docs/memory-providers.md](../../docs/memory-providers.md) and
[docs/openmem-config.md](../../docs/openmem-config.md).

## Cognify defaults (GLiNER + FastEmbed)

Fresh setup / `./setup --yes` with no LLM answers writes:

```env
GRAPH_EXTRACTOR=gliner_demo
EMBEDDING_PROVIDER=fastembed
EMBEDDING_MODEL=BAAI/bge-small-en-v1.5
EMBEDDING_DIMENSIONS=384
AUTO_FEEDBACK=false
```

The pinned image already includes `gliner2` and `fastembed`. First cognify
downloads ~800 MB of models into `HF_HOME` / `FASTEMBED_CACHE_PATH` under the
`cognee-data` volume (`/cognee-storage/.cache/...`). Changing embedding
dimensions (for example from Ollama's 768 to FastEmbed's 384) requires
rebuilding vectors — prune datasets or recreate the `cognee-data` volume.

Overrides: `PM_COGNEE_LLM_PROVIDER=ollama` (Ollama LLM + embeddings), or
`PM_COGNEE_LLM_API_KEY` / Clack "OpenAI-compatible". `EMBEDDING_PROVIDER=fastembed`
is allowed with Ollama LLM.

## Coding agents (no plugin package)

Agents use the REST API (`/docs`, `/health`, `/api/v1/add`, `/cognify`, `/search`)
or the **read-only** stdio MCP shipped in this repo.

### Cursor MCP (`~/.cursor/mcp.json`)

When `MEMORY_PROVIDER=cognee`:

```sh
npx openmem install-mcp --yes --provider-only
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
# or: openmem-cognee-mcp
```

Base URL resolution inside the MCP: `COGNEE_API_URL` / `COGNEE_URL`, else
`http://127.0.0.1:${COGNEE_PORT|8766}`. If you enable auth in compose, export
`COGNEE_API_KEY` in the agent environment (not in `mcp.json`).

v1 MCP is read-only (no add/cognify). Ingest stays with the indexer or curl.

### Switch to / from Cognee

```sh
npx openmem switch cognee --yes
# later: npx openmem switch hindsight --yes
# checkout: npx . switch cognee --yes
```

Updates `wizard.conf` (and `config.toml` `[memory].provider` when present), restarts the stack
unless `--no-stack`, and runs `install-mcp --provider-only` unless `--no-mcp`. Does **not**
migrate memories. Flags: [README — Switch memory provider](../../README.md#switch-memory-provider).
