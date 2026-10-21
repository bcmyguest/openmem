# personal-memory website

Static landing page and docs for personal-memory, built with [Astro](https://astro.build) and [Starlight](https://starlight.astro.build), managed with pnpm.

The site states only what the repository records. Provider support is never written by hand: a build step reads `providers/*/manifest.json` and renders the status badges from it, so the site cannot claim a provider the manifests do not declare.

## Stack

- Astro 7 with Starlight for `/docs/` (search, code highlighting, copy buttons, light and dark themes).
- Tailwind CSS 4 on the landing page, with small shadcn-style `Button`, `Card`, `Badge`, and `CodeBlock` components in `src/components/ui/`.
- Colors come from `src/theme.yml`. `scripts/gen-theme.mjs` turns it into `src/styles/tokens.css` for both the landing page and Starlight, and fails if a text and background pair drops below WCAG AA (4.5:1).
- No React islands. The landing page ships two small inline scripts (theme toggle and copy buttons) and no framework runtime.
- No analytics, no third-party requests: fonts are self-hosted through `@fontsource`.

## Commands

Requires Node 22 or newer (CI uses 24) and pnpm. The pnpm version is pinned in `package.json` (`packageManager`); `corepack enable` picks it up.

```sh
cd site
pnpm install --frozen-lockfile
pnpm dev             # sync, theme tokens, then the dev server
pnpm build           # sync -> theme -> astro build -> privacy check -> link check
pnpm preview         # serve dist/ (honours BASE_PATH)
pnpm test            # unit tests for the sync, privacy, and link scripts
pnpm check:privacy   # re-run the dist/ and doc-source privacy scan
pnpm check:links     # re-run the dist/ link check
pnpm check:sources   # advisory scan of the wider repo docs (never fails)
pnpm render-diagrams # refresh public/diagrams/*.svg after editing mermaid in docs/
```

Before merging changes under `docs/` that contain ` ```mermaid ` blocks, run `pnpm render-diagrams` and commit the updated SVGs under `public/diagrams/`. The normal `pnpm build` only embeds those files; it does not run Puppeteer. CI runs `pnpm test` and `pnpm build` in this directory (see `.github/workflows/ci.yml` and `pages.yml`).

Build for the production location, then smoke it:

```sh
SITE_URL=https://bcmyguest.github.io BASE_PATH=/personal-memory/ pnpm build
SITE_URL=https://bcmyguest.github.io BASE_PATH=/personal-memory/ pnpm preview
curl -I http://localhost:4321/personal-memory/
```

`SITE_URL` and `BASE_PATH` default to the values in `src/site.config.mjs` (`https://bcmyguest.github.io` and `/personal-memory/`). Use `BASE_PATH=/` for a custom domain at the root.

## Where content comes from

`pnpm sync` (run by `dev` and `build`) writes the generated inputs. Nothing generated is committed (see `.gitignore`).

| Output | Source |
| --- | --- |
| `src/generated/providers.json` | `../providers/*/manifest.json`: id, label, status, compose services, port, native docs |
| `src/content/docs/docs/provider-status.md` | the same manifests |
| `src/content/docs/docs/memory-providers.md` | `../docs/memory-providers.md` |
| `src/content/docs/docs/provider-wizard-hooks.md` | `../docs/provider-wizard-hooks.md` |
| `src/content/docs/docs/personal-memory-config.md` | `../docs/personal-memory-config.md` |
| `src/content/docs/docs/npx-install.md` | `../docs/npx-install.md`, skipped when the file does not exist |
| `src/generated/docs.json` | the pages above, in sidebar order (read by `astro.config.ts`) |

Hand-written and committed: `src/content/docs/docs/getting-started.md`, the landing page (`src/pages/index.astro`, copy in `src/lib/content.ts`), and the diagram (`src/components/landing/ArchitectureFigure.astro`).

For each doc source the sync step drops the H1 (Starlight renders the title from frontmatter), adds frontmatter, and rewrites relative links:

- a link to another published doc becomes a site page link;
- a link to any other file or directory in the repository becomes a GitHub `blob` or `tree` URL on `site.branch`;
- a link to a path that does not exist fails the build.

To publish another doc, add an entry to `PAGES` in `scripts/lib/docs.mjs`.

## Install state and provider status

`src/site.config.mjs` has `npm.published: false`. While it is false, the install section shows `npx personal-memory` with the label "Available after the first npm release", without a copy button, and the "Up next" list names the release. Flip it to `true` in the same change that publishes the package. The from-source path (`git clone` and `./setup`) is shown as the path that works today.

Provider badges, the self-host column, the "Up next" entries for non-supported providers, the OG image chips, and `llms.txt` all derive from the manifests. A manifest with an unknown `status` fails the build (allowed: `supported`, `experimental`, `planned`).

## Privacy check

`pnpm build` runs `scripts/check-privacy.mjs` over `dist/` and over every published doc source. It fails, listing file, line, and rule, on:

- home paths (`/home/<name>`, `/Users/<name>`, `C:\Users\<name>`);
- `host.docker.internal`;
- private, carrier-grade NAT, and link-local IPv4 addresses, LAN hostnames, and email addresses;
- operator machine names (`box d`);
- env-style secret assignments (`LITELLM_MASTER_KEY=`, `API_KEY=`, `TOKEN=`, and any `*KEY|TOKEN|SECRET|PASSWORD=value`), plus common secret shapes (API keys, GitHub tokens, JWTs, PEM private keys);
- any literal on your deny list.

Explicit placeholders (`=...`, `=<token>`, `=$VAR`, `=replace-me`, `=val`) are documentation and pass. Nothing is redacted or stripped: a finding fails the build and the source doc is what you fix.

Rules live in `scripts/lib/privacy.mjs`. Matches inside code (`<pre>`, `<code>`, copy-button attributes, Markdown fences and inline code) can be admitted by an entry in `scripts/privacy-allowlist.json`:

```json
{
  "rule": "docker-host",
  "match": "host.docker.internal",
  "files": ["docs/some-doc.md", "dist/docs/some-doc"],
  "reason": "why this exact string is safe to publish"
}
```

An entry needs the rule id, the exact matched string, at least one file path prefix, and a reason. It never covers prose, and secret rules cannot be allowlisted. Unused entries print a warning so stale ones get removed. An entry with a `todo` field is a temporary exemption that someone owes a fix.

Personal literals (names, user names, machine names) go one per line in `.privacy-deny.local`, which Git ignores, or in `PRIVACY_DENY` (comma-separated). In CI, put that list in a secret and expose it as `PRIVACY_DENY`; the current workflow uses no secrets, so add that only if you want the extra gate.

`pnpm check:sources` is an advisory report over the README, all of `docs/`, `.agents/`, the provider manifests, and the config examples. It marks findings in published sources and always exits 0. Use it to see what a doc change would trip before it reaches the build.

## Link check

`scripts/check-links.mjs` walks `dist/` and requires every internal `href` and `src` to resolve to a file under the base path, and every `#fragment` to exist on its target page. A root-absolute link that ignores the base path fails.

## Generated at build time

| Path | Source |
| --- | --- |
| `/og.png` | `src/pages/og.png.ts` (Satori and resvg), provider chips from the manifests |
| `/robots.txt`, `/sitemap-index.xml` | `src/pages/robots.txt.ts`, Starlight's sitemap |
| `/llms.txt`, `/llms-full.txt` | `src/pages/llms*.txt.ts` |
| `/docs/<page>.md` | `src/pages/docs/[slug].md.ts`: plain Markdown of each docs page |

`astro build` prints one warning, `Entry docs -> 404 was not found`. Starlight renders its own 404 page; the message is harmless.

## Deploy

`.github/workflows/pages.yml` builds and deploys with the GitHub Actions Pages flow: `actions/upload-pages-artifact` and `actions/deploy-pages`, with `permissions: contents: read, pages: write, id-token: write`, no secrets, and third-party actions pinned to commit SHAs. It runs on pushes to `main` that touch `site/**`, `providers/*/manifest.json`, `docs/**`, or the workflow file, and on manual dispatch. It never uses `pull_request_target`. The build job runs `pnpm test` and `pnpm build`, so a privacy or link finding stops the deploy.

One-time, manual, before the first deploy:

1. Repository Settings, Pages, Source: **GitHub Actions**.
2. Confirm the repository can use Pages. **GitHub Pages on a private repository needs a paid plan (Pro, Team, or Enterprise).** On a free plan the repository must be public first. The site then lives at `https://bcmyguest.github.io/personal-memory/`, and the published site is public even when the repository is private (unless the organization uses Enterprise Cloud access control).
3. Trigger the workflow with "Run workflow" (or push a change under `site/`), and open the URL from the deploy job.

To move to a custom domain, set `SITE_URL` and `BASE_PATH=/` in the workflow `env` and update `src/site.config.mjs`.

## Content rules

Every statement on the landing page and in `getting-started.md` comes from the repository README or `docs/`. Do not add features, benchmarks, testimonials, logos, user counts, release dates, or provider support that the repository and its manifests do not record. Name providers on the landing page only through the manifest data.
