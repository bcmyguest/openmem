# mem0 (self-hosted REST)

This stack does **not** run mem0 in Docker. You run a [self-hosted mem0 REST server](https://docs.mem0.ai/open-source/features/rest-api); setup only points the shared indexer at it.

**Not** the hosted platform at `https://api.mem0.ai` (different API shape).

## What you run vs what personal-memory runs

| You | personal-memory |
| --- | --- |
| mem0 server (JWT, Postgres/pgvector, embedder keys) | `MEMORY_SINK=mem0`, `MEM0_API_URL` / `MEM0_INDEXER_URL` in stack env |
| API key in `~/.config/personal-memory/mem0.env` (mode **600**) | Smoke: docs, retain, search, delete-by-id |
| Bind server so the indexer container can reach it (see below) | `npx personal-memory install-mcp` registers Cursor MCP |

## URLs

- **`MEM0_API_URL`** — what you curl from the host (default port **18888**).
- **`MEM0_INDEXER_URL`** — derived for the indexer container from `MEM0_API_URL` (loopback on the host is rewritten to the bridge gateway Docker uses). Do not hand-set this to loopback from inside the container.

On Linux, a process bound only to loopback may be unreachable from the indexer container. Bind mem0 to `0.0.0.0` or use a hostname the certificate covers for HTTPS.

## API key

```text
~/.config/personal-memory/mem0.env
# MEM0_API_KEY=…
```

Never put the key in stack `.env`, `wizard.conf`, `config.toml`, or `mcp.json`. With **`AUTH_DISABLED=true`** (dev only), no key is required.

## Coding agents and MCP

There is no Hindsight-style plugin. Agents use the mem0 SDK, REST, or MCP.

Mem0’s cloud MCP (`https://mcp.mem0.ai`) is **not** for self-hosted REST. This repo registers [`@yeyuan98/mem0-mcp`](https://www.npmjs.com/package/@yeyuan98/mem0-mcp) via `cli/mem0-mcp.mjs` (reads the key from the env file).

```sh
MEMORY_PROVIDER=mem0 npx personal-memory install-mcp --yes
# or: npx personal-memory install-mcp --yes --provider-only
```

Restart Cursor Agent after install. Existing `hindsight`, `codegraph`, and `notebooklm` servers are left alone.

## Switch provider

```sh
npx personal-memory switch mem0 --yes
# later: npx personal-memory switch hindsight --yes
```

Updates active provider config, restarts the stack (unless `--no-stack`), runs MCP install (unless `--no-mcp`). Does **not** migrate memories.

See also [Architecture](architecture.md) and [Provider status](https://bcmyguest.github.io/personal-memory/docs/provider-status/).
