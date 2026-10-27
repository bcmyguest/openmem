# Publish OpenMem MCP listings

Do this **after** `@bcmyguest/openmem@0.6.1` (or later) is on npm and `main` has `glama.json` / `server.json`.

Install commands (npm package `@bcmyguest/openmem`; CLI bin `openmem`; MCP bin `openmem-mcp`):

```text
npx -y @bcmyguest/openmem
npx -y -p @bcmyguest/openmem openmem-mcp
```

One-line pitch:

> Memory interface for coding agents — stable `memory_*` tools over Hindsight, mem0, or Cognee (wizard + indexer included).

## 1. npm (required for most registries)

```sh
# First publish of the `@bcmyguest/openmem` package (Trusted Publisher not set yet):
npm login
npm publish --access public

# Later versions: push tag vX.Y.Z → .github/workflows/release.yml
# npm Trusted Publisher: package @bcmyguest/openmem, repo bcmyguest/openmem, workflow release.yml
```

Flip `site.npm.published` to `true` in `site/src/site.config.mjs` in the same change that lands the first npm release.

Do **not** publish unscoped `openmem` (blocked as too similar to `open-mem`) or `openmem-mcp` / `openmemory` (taken). Package is `@bcmyguest/openmem`; MCP entrypoint is the `openmem-mcp` bin.

## 2. Glama

1. Open https://glama.ai/mcp/servers → **Add MCP Server**
2. GitHub URL: `https://github.com/bcmyguest/openmem`
3. Name: **openmem-mcp** · Description: the pitch above · Type: **stdio**
4. Install (stdio MCP): `npx -y -p @bcmyguest/openmem openmem-mcp`
5. After indexing, **Claim ownership** (repo already has `glama.json` with maintainer `bcmyguest`)

Listing name on Glama: **openmem-mcp**. Canonical URL (repo slug): `https://glama.ai/mcp/servers/bcmyguest/openmem` (also resolves with `@bcmyguest/openmem`).

README / awesome-list badges must use the **repo slug** path (`bcmyguest/openmem`). The listing-name path `@bcmyguest/openmem-mcp` returns a “not listed” badge. Score badge links to `/score`.

### Unlock Glama quality / security grades

A Glama **release** is a containerized build (not a GitHub tag). Auto-Release stays blocked until the first manual release exists.

1. **Sync Server**, then confirm claim (`glama.json` maintainers).
2. **Admin → Dockerfile** (Glama generates the image; wraps CMD with `mcp-proxy --`). Prefer the npm recipe (`@bcmyguest/openmem` is published):

| Field | Value |
| --- | --- |
| Build steps | `["npm install -g @bcmyguest/openmem@latest"]` |
| CMD arguments | `["openmem-mcp"]` |
| Env schema | `{"type":"object","properties":{},"required":[]}` |
| Placeholder parameters | `{}` |
| Pinned commit | empty (or any SHA — npm recipe ignores repo tree for the binary) |

Source alternative (do not mix): `["npm ci --omit=dev"]` + `["node", "cli/openmem-mcp.mjs"]`.

3. **Deploy** (build test) → **Make Release** (e.g. `0.6.4`) → **Create & Publish Release**. Then Auto-Release can publish on later commits.
4. Seed usage with **Try in Browser** once so “No recent usage” clears.

Repo also ships a root `Dockerfile` aligned with the source recipe for local `docker build` checks.

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
