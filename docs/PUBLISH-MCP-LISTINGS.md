# Publish OpenMem MCP listings

Do this **after** `openmem@0.6.1` (or later) is on npm and `main` has `glama.json` / `smithery.yaml` / `server.json`.

Install command for listings:

```text
npx -y openmem-mcp
```

One-line pitch:

> Memory interface for coding agents — stable `memory_*` tools over Hindsight, mem0, or Cognee (wizard + indexer included).

## 1. npm (required for most registries)

```sh
# First publish of the `openmem` package (Trusted Publisher not set yet):
npm login
npm publish --access public

# Later versions: push tag vX.Y.Z → .github/workflows/release.yml
# npm Trusted Publisher: package openmem, repo bcmyguest/openmem, workflow release.yml
```

Flip `site.npm.published` to `true` in `site/src/site.config.mjs` in the same change that lands the first npm release.

## 2. Glama

1. Open https://glama.ai/mcp/servers → **Add MCP Server**
2. GitHub URL: `https://github.com/bcmyguest/openmem`
3. Name: **OpenMem** · Description: the pitch above · Type: **stdio**
4. Install: `npx -y openmem-mcp`
5. After indexing, **Claim ownership** (repo already has `glama.json` with maintainer `bcmyguest`)

Expected URL: `https://glama.ai/mcp/servers/@bcmyguest/openmem` (exact slug may vary)

README already has the Glama score badge for that path. After the listing is live and scored, the badge fills in; until then it may look empty/broken — that is expected.

## 3. Smithery

1. Sign in at https://smithery.ai with GitHub `bcmyguest`
2. https://smithery.ai/new → **Add from GitHub** → `bcmyguest/openmem`
3. Confirm `smithery.yaml` / `npx -y openmem-mcp`
4. Tags: `memory`, `coding-agents`, `hindsight`, `mem0`, `cognee`, `mcp`

README already has the Smithery badge linking to `@bcmyguest/openmem`. If Smithery assigns a different slug, update the badge URLs in `README.md` to match.

## 4. Official MCP Registry

```sh
# After npm publish (mcpName must match server.json name):
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher
./mcp-publisher login github
./mcp-publisher publish ./server.json
```

Bump `version` in `server.json` (and the packages[].version) whenever you publish a new npm version.

## 5. Community lists (optional)

- [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) — PR a Community Servers row
- [PulseMCP](https://www.pulsemcp.com/) — submit if they take GitHub/npm URLs
- [mcp.so](https://mcp.so/) — submit repo URL when their form is open

## 6. Announce

Use [docs/ANNOUNCEMENT.md](ANNOUNCEMENT.md) (I-built-a-thing draft). After Glama/Smithery URLs exist, paste them into the post and the README badges.
