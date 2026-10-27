# Publish OpenMem MCP listings

Do this **after** `openmem@0.6.1` (or later) is on npm and `main` has `glama.json` / `server.json`.

Install command for listings (npm package is `openmem`; MCP bin is `openmem-mcp`):

```text
npx -y openmem
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

Do **not** publish as `openmem-mcp` — that name is already taken on npm by an unrelated package. Our MCP entrypoint is the `openmem-mcp` bin inside `openmem`.

## 2. Glama

1. Open https://glama.ai/mcp/servers → **Add MCP Server**
2. GitHub URL: `https://github.com/bcmyguest/openmem`
3. Name: **openmem-mcp** · Description: the pitch above · Type: **stdio**
4. Install: `npx -y openmem` (runs the package; MCP binary is `openmem-mcp`)
5. After indexing, **Claim ownership** (repo already has `glama.json` with maintainer `bcmyguest`)

Listing name on Glama: **openmem-mcp**. Canonical URL (repo slug): `https://glama.ai/mcp/servers/@bcmyguest/openmem`

README badges use the Glama name (`@bcmyguest/openmem-mcp` score/card images) and link to that canonical page.

## 3. Official MCP Registry

```sh
# After npm publish (mcpName must match server.json name):
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher
./mcp-publisher login github
./mcp-publisher publish ./server.json
```

Bump `version` in `server.json` (and the packages[].version) whenever you publish a new npm version.

## 4. Community lists (optional)

- [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) — PR a Community Servers row
- [PulseMCP](https://www.pulsemcp.com/) — submit if they take GitHub/npm URLs
- [mcp.so](https://mcp.so/) — submit repo URL when their form is open

## 5. Announce

Use [docs/ANNOUNCEMENT.md](ANNOUNCEMENT.md) (I-built-a-thing draft). After the Glama URL is live, paste it into the post and confirm the README badges.
