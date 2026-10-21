# Installing with npx

`personal-memory` is an npm package whose CLI runs the same setup wizard as `./setup` in a
checkout. The package name lives in one place, the `name` field of `package.json` (the CLI
command stays `personal-memory` if you switch to a scoped name such as
`@bcmyguest/personal-memory`).

Requirements: Node ≥ 20.12 (the floor of `@clack/prompts`), Docker with the compose v2
plugin (`docker compose version`), `curl`. Linux and macOS are supported; there is no
bash dependency in the CLI (macOS ships bash 3.2).

Wizard phases and flags live in the repository: [docs/setup-wizard.md](https://github.com/bcmyguest/personal-memory/blob/main/docs/setup-wizard.md). Runtime architecture: [architecture.md](architecture.md).

## Install paths

```sh
npx personal-memory                 # interactive setup, nothing installed globally
npx personal-memory setup           # same as the bare command
npx personal-memory configure --yes # non-interactive setup and start
npx personal-memory up              # start stack
npx personal-memory install-mcp --yes
npx personal-memory switch mem0 --yes
npm i -g personal-memory            # then: personal-memory setup | up | down | ...
# From a git checkout (package not required on the registry):
git clone https://github.com/bcmyguest/personal-memory && cd personal-memory
npm install && npx . setup          # same wizard; also: npm run setup / ./setup
```

No global `pm` command is installed: it collides with Android's `pm`. `./pm` and `npm run pm`
exist only inside a checkout; prefer `npx personal-memory …` (or `npx . …` in a checkout).

### Commands

| Command | What it does |
| --- | --- |
| `personal-memory` / `setup` | interactive setup; extra flags go to the wizard (`--yes`, `--dry-run`, `--no-smoke`, `--rebuild`) |
| `configure` | non-interactive setup and start (`setup --yes`) |
| `up` / `down` | start / stop the stack with the saved configuration |
| `doctor` | validate the configuration without the smoke test |
| `install-mcp` | merge **personal-memory** unified MCP (`memory_*`) by default; NotebookLM when sync is on or `--notebooklm`; native mem0/Cognee with `--provider-only`; `--no-unified-mcp` to skip |
| `switch <provider>` | change `MEMORY_PROVIDER` (optional stack restart + MCP; no data migration) |
| `providers [--json]` | list the provider manifests shipped in the package with their status |
| `init [--force] [--dry-run] [--json]` | create or upgrade the stack root without running the wizard |
| `--version`, `--help` | |

`--version`, `--help` and `providers` touch nothing on disk. Every other command first
brings the stack root up to date, then runs the wizard.

## Stack root

Under npx the package directory is a read-only, garbage-collected cache, but the wizard
writes `.env`, `.build-hash` and `compose.override.yaml` and drives compose files and docker
build contexts relative to its repo root. The CLI therefore keeps a stable, writable
**stack root**:

```
${PM_STACK_ROOT:-${XDG_DATA_HOME:-~/.local/share}/personal-memory/stack}
```

Layout after `personal-memory init`:

```
stack/
  .pm-stack-manifest.json   sha256 of every shipped file as last written (do not edit)
  compose.yaml              shipped
  compose.bench.yaml        shipped
  indexer/  bin/  sync/     shipped (docker build contexts)
  config/                   shipped templates: *.example, index.yml, notebooklm.yml,
                            litellm.*.yaml, coding-agent.json
  providers/<id>/compose*.yaml   shipped provider compose fragments
  .env  .build-hash  compose.override.yaml  personal-memory.toml  ...   generated: never touched
```

The wizard code itself (`wizard/`, `scripts/`, provider manifests and hooks) is **not**
copied: it runs from the package, so `@clack/prompts` resolves from the package's own `node_modules`.
Per-user config stays where it always was: `~/.config/hindsight/` and
`~/.config/personal-memory/config.toml`.

### Environment variables

| Variable | Meaning |
| --- | --- |
| `PM_STACK_ROOT` | Mutable stack root = the wizard's `ctx.repoRoot` (compose project dir, `.env`, generated files, docker build context). Overrides the default location. |
| `PM_USE_CHECKOUT=1` | Use the package directory itself as the stack root and copy nothing. Wins over `PM_STACK_ROOT`. A directory containing `.git` next to `cli/` behaves this way automatically. |
| `PM_PACKAGE_ROOT` | Read-only code root (provider manifests and hooks, `scripts/setup.mjs`, `wizard/lib`), never written to. Set by the CLI; defaults to the package directory. |
| `PM_PROJECT` | compose project name (default `personal-memory`). |
| `XDG_DATA_HOME` | Base for the default stack root (must be absolute). |

`wizard/bin/setup.mjs` and `wizard/bin/pm.mjs` read `PM_STACK_ROOT` and `PM_PACKAGE_ROOT`
(defaulting both to the checkout root) and export them to child processes. Running them
directly from inside an npm package directory without `PM_STACK_ROOT` is refused.

## Upgrades

Each command compares the package's shipped files with the stack root using the manifest:

- Missing file: created (restored if it was shipped before).
- Identical: left alone.
- On disk equals what the previous version wrote: overwritten with the new version
  (atomic write: temp file in the same directory, then rename).
- Modified by you, or present but not tracked, or a symlink: **kept**, reported as
  `CONFLICT <path>`. The wizard still runs against your version. Merge by hand, or run
  `personal-memory init --force`, which overwrites it and saves yours as
  `<file>.user-<timestamp>.bak`.
- No longer shipped: left in place and reported as a note.
- Generated files (`.env`, `.build-hash`, `compose.override.yaml`, `personal-memory.toml`,
  anything not in the manifest) are never overwritten or deleted.

After an upgrade the wizard's `.build-hash` check rebuilds the images when their sources
changed.

## Uninstall

```sh
personal-memory down                          # stops the stack (docker compose down)
npm uninstall -g personal-memory              # if installed globally
rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/personal-memory"   # the stack root
```

`~/.config/hindsight/` (secrets, `index.yml`) and `~/.config/personal-memory/` are kept
until you delete them yourself.

## Linux and macOS notes

- Linux: the user must be able to run `docker` without sudo. `host.docker.internal`
  is mapped through `extra_hosts` in `compose.yaml`.
- macOS: use Docker Desktop or Colima with the compose v2 plugin and allow file sharing
  for your home directory (the indexer bind-mounts `$HOME` read-only). 
- Windows is untested; use WSL2.

## Troubleshooting

- `CONFLICT <path>`: see Upgrades. It is a warning; the stack still works.
- `cannot prepare the stack root`: the directory is not writable. Set `PM_STACK_ROOT` to
  a writable path.
- `read-only ... Run it through the CLI`: you ran `wizard/bin/*.mjs` from inside the npm
  cache. Use `npx personal-memory` or set `PM_STACK_ROOT`.
- `missing dependencies (@clack/prompts ...)`: reinstall the package (`npm i -g
  personal-memory`), or in a checkout run `npm install` at the checkout root.
- `... is not valid JSON` for `.pm-stack-manifest.json`: delete the manifest; shipped
  files that differ from the package are then reported as untracked conflicts instead of
  being overwritten.
- Port already in use: set `HINDSIGHT_PORT` / `HINDSIGHT_CP_PORT`, or let the wizard pick
  a free port.

## Maintainers: publishing

Before the first publish (these are human steps; nothing in this repo does them):

1. **License.** The repository ships `LICENSE` (Apache-2.0) and `package.json` matches.
2. **Public source.** `npm publish --provenance` needs a public GitHub repository.
3. **Pack gate.** `npm run pack:check` must pass (no operator home paths in shipped files).
4. **Create the npm package.** Log in with 2FA (`npm login`), then publish `0.1.0` once by
   hand (`npm publish --access public`). The name `personal-memory` was verified free on
   2026-10-19 (so was `@bcmyguest/personal-memory`); re-check with `npm view personal-memory`.
5. **Trusted publishing.** On npmjs.com, package Settings -> Trusted Publisher -> GitHub
   Actions: owner `bcmyguest`, repository `personal-memory`, workflow `release.yml`.
6. **Release.** Run the *Prepare release* workflow on `main` (or bump `package.json`, tag
   `vX.Y.Z`, and push the tag). `release.yml` runs CI, then publishes with `--provenance`
   when the version is not already on npm, then creates the GitHub Release.

Local rehearsal without publishing:

```sh
npm run pack:check
npm pack --pack-destination /tmp/pm-pack
cd "$(mktemp -d)" && npx --yes /tmp/pm-pack/personal-memory-*.tgz --version
```
