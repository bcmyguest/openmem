# Development

Guide for working in the OpenMem git repository: checkout, git hooks, and test suites. End users usually install with [npx](getting-started.md); this page is for contributors and anyone running from a clone.

## Checkout

```sh
git clone https://github.com/bcmyguest/openmem.git
cd openmem
```

With **[mise](https://mise.jdx.dev/)** (recommended in this repo):

```sh
mise trust          # once per clone
mise install        # node 24, python 3.12, uv, pnpm (see [.mise.toml](../.mise.toml))
mise run bootstrap  # npm ci, uv sync, site pnpm
```

Without mise: `npm install`, then `uv sync --group dev`, and `pnpm --dir site install` when you work on the site.

Common tasks: `mise run test`, `mise run test:python`, `mise run lint`, `mise run prek`, `mise run ci`. Stack up/down still uses [`./pm`](openmem-config.md) / `npm run pm -- up` (openmem’s mise-*like* `config.toml`, not mise itself).

Run the wizard from the repo root (same as npx, but uses this tree):

```sh
npm run setup
# or: node cli/openmem.mjs setup
```

Other CLI entry points: `npm run openmem -- <command>`, `node cli/openmem.mjs <command>`, or `./setup` after `npm install`.

| Tool | Version | Used for |
| --- | --- | --- |
| Node.js | ≥ 24 | CLI, wizard, `npm test`, session store in tests (`node:sqlite`) |
| [uv](https://docs.astral.sh/uv/) | current | Python dev deps and pytest (`pyproject.toml`, `uv.lock`) |
| Docker Compose v2 | v2.24+ for some pytest | Optional locally; compose profile tests skip when unavailable |
| pnpm | (see `site/package.json`) | Docs site under `site/` |

Wizard and Node tests stub Docker and HTTP; you do not need a running stack for `npm test`.

## Git hooks (prek)

Use **[prek](https://github.com/j178/prek)**, not the Python `pre-commit` package. Config is [`.pre-commit-config.yaml`](../.pre-commit-config.yaml) (hygiene + Conventional Commits on `commit-msg`, aligned with [prepare-release](../.github/workflows/prepare-release.yml)).

One-time setup:

```sh
./setup_prek.sh
```

Day to day:

```sh
prek run              # staged files
prek run --all-files  # whole repo (matches CI)
prek update --freeze  # refresh frozen hook SHAs
```

Local hooks (via [`.pre-commit-config.yaml`](../.pre-commit-config.yaml) `repo: local`):

| Hook | Command | Scope |
| --- | --- | --- |
| `eslint` | `npm run lint` | Root JavaScript (`.mjs` / `.js` under `cli/`, `wizard/`, `scripts/`, `providers/`, …; not `site/`) |
| `typecheck-site` | `npm run typecheck:site` | Docs site (`pnpm --dir site run typecheck` → `tsc -b` + `astro check`) |

Run the same checks without prek:

```sh
npm run lint
npm run lint:fix
npm run typecheck:site   # or: pnpm --dir site run typecheck
```

### TypeScript 7.1 + Astro check (docs site)

The site uses two TypeScript packages on purpose: the **`tsc` binary is TypeScript 7.1** (`@typescript/native` → `typescript@7.1.0-beta` until 7.1 stable); **`@astrojs/check` keeps the TS6 API** via the `typescript` package alias (`@typescript/typescript6`). **`pnpm --dir site run typecheck`** runs **`tsc -b`** then **`astro check`** — both must pass in CI prek.

Root `.mjs` is eslint-only (no `checkJs` tsc — too noisy until typed incrementally).

## Node and wizard tests

```sh
npm test              # every scripts/tests/test_*.mjs + scripts/tests/test_wizard.sh
npm run test:unit     # faster CLI package subset (test_cli_package.mjs --unit)
npm run pack:check    # npm pack contents gate (also runs in CI)
```

`npm test` does not run Python or site tests. Individual Node test files: `node scripts/tests/test_<name>.mjs`.

## Python tests (pytest + uv)

Dependencies live in the root [`pyproject.toml`](../pyproject.toml) dev group. Proxy tests are `unittest.TestCase` classes; pytest collects them.

```sh
uv sync --group dev
uv run pytest -q                    # indexer/tests + proxy/tests (pytest-xdist -n auto, pytest-sugar)
npm run test:python                 # same
npm run test:indexer                # indexer only
npm run test:proxy                  # proxy only
```

CI uses `uv sync --locked --group dev` and `uv run --locked pytest -q` on Python 3.12. Do not use bare `pip install pytest` or `python3 -m pytest` outside the uv environment.

Compose integration tests under `indexer/tests/test_*_compose.py` need Docker Compose v2.24+ and are skipped otherwise.

## Docs site

```sh
cd site
pnpm install --frozen-lockfile
pnpm test
pnpm build
```

CI runs the same on push/PR. Regenerate benchmark media and diagrams: see [docs/assets/README.md](assets/README.md) and the site media note in [CLAUDE.md](../CLAUDE.md).

## CI parity

GitHub Actions [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs four jobs on each PR:

| Job | Command |
| --- | --- |
| prek | `prek run --all-files` |
| Node | `npm test`, `npm run pack:check` (matrix Node 24.0.0 and 24) |
| Python | `uv run --locked pytest -q` |
| site | `pnpm test`, `pnpm build` |

Before opening a PR, run the suites that touch your change and mention them in the description. Process and scope expectations: [CONTRIBUTING.md](../CONTRIBUTING.md).

## Related repo-only docs

These stay in `docs/` for contributors and are not all synced to the public docs site:

- [Pluggable memory providers](memory-providers.md) — adding a provider
- [Coding agents](coding-agents.md), [wizard hooks](coding-agent-hooks.md)
- [Evidence plan](evidence-plan.md) — ContextBench and replay methodology
