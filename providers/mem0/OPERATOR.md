# mem0 operator runbook (URL-only)

This stack does **not** run a mem0 container. You run a [self-hosted mem0 REST
server](https://docs.mem0.ai/open-source/features/rest-api); `./setup` only points
the shared indexer at it.

**Not** the hosted platform at `https://api.mem0.ai`. That API shape differs
(`/v1/…`); the indexer sink and wizard smoke talk to the open-source REST
server only (no `/v1/` prefix).

## What `./setup` owns vs what you own

| You (provider-native) | This stack |
| --- | --- |
| Start the mem0 REST server (JWT, Postgres/pgvector, dashboard) | Write `MEM0_API_URL` / `MEM0_INDEXER_URL` into the stack `.env` |
| Embedder / LLM keys for mem0 itself | Indexer sink (`MEMORY_SINK=mem0`) and host-gateway rewrite |
| Create an API key (dashboard or `POST /api-keys`) | Store `MEM0_API_KEY` in `~/.config/personal-memory/mem0.env` (mode **600**) |
| Optional `AUTH_DISABLED=true` (dev only) | Smoke: `GET /docs`, retain, search, delete-by-id |

## URLs

- **`MEM0_API_URL`** — host view (what you curl from this machine), e.g.
  `http://127.0.0.1:18888`. Default port in the manifest is **18888**.
- **`MEM0_INDEXER_URL`** — container view. `./setup` derives it from
  `MEM0_API_URL` by rewriting loopback hosts (`127.0.0.1`, `localhost`,
  `0.0.0.0`, `[::1]`) to `host.docker.internal`. Do not hand-edit it to
  `127.0.0.1` inside the container; validation requires it to match that rewrite.

## Linux loopback

`host.docker.internal` is the docker bridge gateway, **not** the host's
`127.0.0.1`. A mem0 process bound only to `127.0.0.1` is unreachable from the
indexer container. Bind the server to `0.0.0.0` (or the bridge IP), or put a
real hostname in `MEM0_API_URL`. An `https://localhost` URL becomes
`https://host.docker.internal`, which usually fails TLS name checks — use a
hostname the certificate covers.

## API key file

```text
~/.config/personal-memory/mem0.env   # mode 600; directory mode 700
MEM0_API_KEY=<key>
```

Never put `MEM0_API_KEY` in the stack `.env` (mode 644), `wizard.conf`, or
`config.toml`. Override the path with `MEM0_ENV_FILE` / `[memory.mem0] env_file`
if needed; then `./setup` must record that path in the stack `.env`.

With **`AUTH_DISABLED=true`** on the server (development only), no key is
required. Auth-enabled servers need a key or smoke/indexer calls return 401.

## Embedder

Search fails if the server's embedder is misconfigured. Smoke looks for the
fact stored with `infer: false`; a miss points at the embedder key and server
logs, not at this stack.

## Cleartext keys

Over plain `http://` to a non-loopback host, `X-API-Key` travels in cleartext.
Prefer `https://`, or keep the server on loopback / the same host.

## Coding agents

There is no `pluginPackage`. Agents talk to your server via the Python SDK,
the self-hosted MCP bridge, or direct REST (`POST /memories`, `POST /search`). The
wizard's coding-agent step prints those paths and can register Cursor MCP; see
`providers/mem0/lib/coding-agent.mjs`.

### Cursor MCP (`~/.cursor/mcp.json`)

Mem0's official MCP (`https://mcp.mem0.ai`) is **platform/cloud only**. For a
self-hosted REST server this repo registers [`@yeyuan98/mem0-mcp`](https://www.npmjs.com/package/@yeyuan98/mem0-mcp)
via the launcher `cli/mem0-mcp.mjs` (loads the key from the env file, then
`npx -y @yeyuan98/mem0-mcp`).

```sh
MEMORY_PROVIDER=mem0 npx openmem install-mcp --yes
# checkout: MEMORY_PROVIDER=mem0 npx . install-mcp --yes
# or accept the coding-agent MCP confirm in setup
```

Shape written (URL and env-file **path** only — never the key value):

```json
{
  "mcpServers": {
    "mem0": {
      "command": "node",
      "args": ["/path/to/openmem/cli/mem0-mcp.mjs"],
      "env": {
        "MEM0_API_URL": "http://127.0.0.1:18888",
        "MEM0_BASE_URL": "http://127.0.0.1:18888",
        "MEM0_ENV_FILE": "~/.config/personal-memory/mem0.env"
      }
    }
  }
}
```

**API key:** the launcher reads `MEM0_API_KEY` from `MEM0_ENV_FILE` when the
variable is not already in the process environment. You can also
`export MEM0_API_KEY=…` (e.g. `set -a; source ~/.config/personal-memory/mem0.env; set +a`)
before starting Cursor so the agent inherits it. **Never** put `MEM0_API_KEY` in
`mcp.json`. Existing `hindsight` / `codegraph` / `notebooklm` servers are left alone.

Restart Cursor Agent after install.

### Switch to / from mem0

```sh
npx openmem switch mem0 --yes
# later: npx openmem switch hindsight --yes
# checkout: npx . switch mem0 --yes
```

Updates `wizard.conf` (and `config.toml` `[memory].provider` when present), restarts the stack
unless `--no-stack`, and runs `install-mcp --provider-only` unless `--no-mcp`. Does **not**
migrate memories. Flags: [README — Switch memory provider](../../README.md#switch-memory-provider).

## Compose

`providers/mem0/compose.yaml` defines no mem0 service — only env +
`extra_hosts` on the shared `indexer`. Profile `mem0` selects that fragment.
