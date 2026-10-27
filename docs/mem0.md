# mem0

**mem0** is a supported OpenMem provider. You run a [self-hosted mem0 REST server](https://docs.mem0.ai/open-source/features/rest-api); OpenMem points the shared indexer and unified `memory_*` MCP at it. One active provider at a time — same agent surface as Hindsight or Cognee.

This is **not** the hosted platform at `https://api.mem0.ai` (different API shape). OpenMem talks to the open-source REST server only (no `/v1/` prefix).

Upstream project: [mem0ai/mem0](https://github.com/mem0ai/mem0). Stack details for contributors: `providers/mem0/OPERATOR.md`.

## What you run vs what OpenMem runs

| You | OpenMem |
| --- | --- |
| mem0 REST server (JWT, Postgres/pgvector, embedder keys) | `MEMORY_PROVIDER=mem0`, `MEMORY_SINK=mem0` |
| API key in `~/.config/personal-memory/mem0.env` (mode **600**) | `MEM0_API_URL` / `MEM0_INDEXER_URL` in stack env |
| Bind so the indexer container can reach the server | Wizard smoke: docs, retain, search, delete-by-id |
| | Unified MCP + optional native mem0 MCP |

Compose profile `mem0` adds env + `extra_hosts` on the shared **indexer** only — there is no mem0 container in this repo yet.

## First-time setup

1. Start your mem0 REST server (default OpenMem port expectation: **18888**).
2. Put the API key in the env file (skip if `AUTH_DISABLED=true` on the server for local dev only):

```text
~/.config/personal-memory/mem0.env
MEM0_API_KEY=…
```

Never put `MEM0_API_KEY` in stack `.env`, `wizard.conf`, `config.toml`, or `mcp.json`.

3. Select mem0 in the wizard, or switch later:

```sh
npx @bcmyguest/openmem              # choose mem0 when prompted
# or:
npx @bcmyguest/openmem switch mem0 --yes
```

4. Confirm:

```sh
npx @bcmyguest/openmem doctor
curl -fsS "$MEM0_API_URL/docs"   # URL from wizard / stack .env
```

## URLs

| Variable | Meaning |
| --- | --- |
| `MEM0_API_URL` | Host view (what you curl), e.g. `http://127.0.0.1:18888` |
| `MEM0_INDEXER_URL` | Derived for the indexer container — loopback hosts are rewritten to the Docker bridge gateway. Do not set this to `127.0.0.1` by hand inside the container. |

**Linux:** a process bound only to loopback is often unreachable from the indexer container. Bind mem0 to `0.0.0.0` (or a real hostname). Prefer `https://` when the server is not on loopback — `X-API-Key` is cleartext on plain HTTP.

Search fails if the server’s embedder is misconfigured; smoke stores with `infer: false` and looks for that fact.

## Banks / scopes

mem0 scopes map to **`user_id`**. OpenMem’s MCP `bank` argument and indexer banks become that `user_id`. Default unified MCP scope is `openmem-mcp` unless tools pass `bank`. Project work should pass the resolved project bank so session noise does not land in the default. See [Concepts — Context and banks](concepts.md#context-and-banks).

## Coding agents and MCP

**Preferred:** unified OpenMem MCP (`memory_*`) — same tools as Hindsight/Cognee:

```sh
npx @bcmyguest/openmem install-coding-agent --yes
# or MCP only:
npx @bcmyguest/openmem install-mcp --yes
```

**Optional native mem0 tools** (upstream `@yeyuan98/mem0-mcp` names, not `memory_*`):

```sh
MEMORY_PROVIDER=mem0 npx @bcmyguest/openmem install-mcp --yes --provider-only
```

That registers `cli/mem0-mcp.mjs` with `MEM0_API_URL` / `MEM0_BASE_URL` and the **path** to `mem0.env` — never the key value in `mcp.json`. Mem0’s cloud MCP (`https://mcp.mem0.ai`) is **not** for self-hosted REST.

Restart Cursor Agent after MCP changes. Full flag matrix: [MCP setup](mcp-setup.md).

There is no Hindsight-style coding-agent plugin for mem0; session hooks + unified MCP cover day-to-day agent memory.

## Portability

Export/import uses **PMM** via `memory_export` / `memory_import` on the unified MCP. Switching providers does **not** migrate data by itself — export, switch, import (or re-index). See [Portable memory (PMM)](memory-portability.md).

## Switch provider

```sh
npx @bcmyguest/openmem switch mem0 --yes
# later:
npx @bcmyguest/openmem switch hindsight --yes
```

Updates active provider config, restarts the stack (unless `--no-stack`), refreshes MCP (unless `--no-mcp`). Does **not** migrate memories.

## Related

- [Concepts](concepts.md) — interface layer
- [MCP setup](mcp-setup.md) — unified vs provider-native
- [Portable memory (PMM)](memory-portability.md)
- [Architecture](architecture.md) · [Provider status](provider-status.md)
