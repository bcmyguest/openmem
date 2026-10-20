# Provider wizard hooks (sub-wizards)

The meta wizard (`./setup`, `./pm`) owns cross-provider steps. Each **provider plugin** ships a
**`providers/<id>/wizard.mjs`** module, the same relationship as asdf/mise plugins: the core tool
runs the plugin's hooks; it does not reimplement Node, Rust, mem0, or a model router.

The meta wizard knows nothing about any one provider. `wizard/lib/run-wizard.mjs`,
`wizard/lib/ports.mjs` and `wizard/lib/validate-setup.mjs` contain no provider names (a test greps
for this). A provider that exports no hook for a phase gets a clean no-op for that phase: there is
no default provider and no fallback implementation.

## Hook API version

`helpers.apiVersion` is `2`. It is bumped when a helper is removed or changes meaning; adding a
helper does not bump it. Version 1 (the `chooseBackend` helper and `fallback:` argument) is gone.
The v1 phase names still work unchanged.

## Package root vs stack root

| Field | Env | Meaning | Used for |
| --- | --- | --- | --- |
| `ctx.repoRoot` | `PM_STACK_ROOT` | Mutable stack root | compose project dir (`cwd` of every `docker compose` call), `.env`, `compose.override.yaml`, `.build-hash`, `config/machine.env`, generated files |
| `ctx.packageRoot` | `PM_PACKAGE_ROOT` (default: `repoRoot`) | Read-only code root | `providers/` manifests and hook modules, `scripts/setup.mjs`, `scripts/gen-masks.mjs` |

For a git checkout they are the same directory. For an installed package the integrator passes the
stack root as `repoRoot` (`runWizard(stackRoot, argv)`) and the package directory through
`PM_PACKAGE_ROOT`. `runWizard` exports `PM_PACKAGE_ROOT` so child code sees it.
`PM_PROVIDERS_DIR` overrides the providers directory entirely (tests use it for fake providers).
Provider code must write only under `ctx.repoRoot` and read bundled files only under
`ctx.packageRoot`.

## Execution order

```
meta.preflight
meta.provider                   pick memory provider (Clack / TOML / --yes)
provider.init                   quiet: seed ctx defaults (also runs before preflight)
provider.resolvePorts           host ports (also after the provider is chosen)
provider.afterProvider
provider.configureModelRouting  models, keys, logins
meta.wizardConf                 written unless the provider already saved it
meta.setupEnv                   indexer state dir, then provider.setupEnv or scripts/setup.mjs
meta.index                      index.yml
meta.notebooklm                 optional profile
provider.beforeStack            compose fragments, migrations
meta.stack                      build, up, health, provider.afterStackHealthy, then smoke
meta.codingAgent                generic npx plugin, then provider.setupCodingAgent
meta.validate                   generic checks, then provider.extendValidation
meta.syncConfig                 config.toml (provider.configToml sections)
meta.summary                    provider.summary
```

**Stack-only actions** (`./setup --up`, `./pm up`) skip the configure phases:

```
meta.preflight -> meta.provider -> hydrate -> provider.resolvePorts -> provider.beforeStack
  -> meta.stack -> meta.validate -> meta.summary
```

**Down** runs `meta.preflight -> meta.stackDown -> meta.summary`. There are no down hooks yet.

## Hook module contract

Path: `providers/<id>/wizard.mjs` (ESM), found through the manifest:

```json
"wizardHooks": { "module": "wizard.mjs" }
```

The path must stay inside the provider directory. Every export is an optional
`async function(ctx, helpers)`; implement only what you need. Hooks marked announced print
`provider <id>: <phase>` when they run; quiet hooks return a value to the meta wizard.

| Export | Kind | Return | When it runs |
| --- | --- | --- | --- |
| `init` | quiet | ignored | Seed provider defaults on `ctx` before anything reads them |
| `hydrate` | quiet | ignored | Restore provider state from the saved `wizard.conf` |
| `afterProvider` | announced | ignored | Right after the provider is selected |
| `configureModelRouting` | announced | ignored | Model backend, API keys, logins. Honor `ctx.skipBackendStep` (Clack already asked) |
| `resolvePorts` | announced | ignored | Choose free host ports (`helpers.choosePort`, `helpers.resolveHostPort`) |
| `stackEnv` | quiet | `{ description?, env? }` | What the generic `scripts/setup.mjs` run should print and receive |
| `setupEnv` | announced | ignored | Replace the generic secrets/env step; call `helpers.runStackSetup` to still run `scripts/setup.mjs` |
| `beforeStack` | announced | ignored | After env and index, before `docker compose up` |
| `apiBase` | quiet | string | HTTP base URL when it is not `http://127.0.0.1:<compose.hostPortEnv>` |
| `smoke` | announced | ignored | Replace the manifest HTTP smoke test |
| `afterStackHealthy` | announced | ignored | After health, before smoke (e.g. pull compose Ollama models) |
| `setupCodingAgent` | announced | ignored | After the generic coding-agent plugin step |
| `extendValidation` | announced | ignored | Push to `ctx.validationErrors` / `ctx.validationChecks`; runs after the generic checks |
| `configToml` | quiet | `{ stack?, memory?, <table>: {...} }` | Sections for `config.toml`: `stack` merges into `[stack]`, `memory` sub-tables (for example `memory.mem0`) merge into `[memory]` and `provider` there is always set by the wizard, every other key is a table |
| `summary` | quiet | `{ running?, configFiles?, notes?, logServices? }` | Lines for the closing summary |
| `clackSetup` | none | `{ env }` | Called by the Clack front end as `(ctxStub, ui, helpers)` |
| `prepareStackEnv` | script | `{ entries, drop, report }` | Called by `scripts/setup.mjs`; `.env` always gets `HOST_UID`/`HOST_GID` |
| `migrateEnv` | script | n/a | `scripts/setup.mjs --migrate-env` |
| `setupNotices` | script | `string[]` | Lines `scripts/setup.mjs` prints at the end |

`prepareStackEnv`, `migrateEnv` and `setupNotices` receive `{ repo, home, env }` (`repo` is the
stack root) and run in a separate Node process, so they may not use `helpers`.

Unrecognised exports are ignored. Providers must not import `wizard/lib/run-wizard.mjs`; it
imports them. Everything the meta wizard owns reaches a hook through `helpers`.

## Helpers

`createHelpers()` in `wizard/lib/provider-wizard/helpers.mjs` returns a frozen object. Functions
that take `ctx` honor `--dry-run` (they print instead of acting).

| Helper | Purpose |
| --- | --- |
| `apiVersion` | `2` |
| `step`, `info`, `ok`, `warn`, `die` | Logging; `die` exits 1 |
| `problem(ctx, msg)` | `die`, or `warn` in a dry run |
| `ask`, `confirm` | Prompts (answers come from `ctx.yes` and `PM_*` env when non-interactive) |
| `act(ctx, desc, cmd, args, {env, cwd})`, `actWithEnv` | Run a command, printed only in a dry run |
| `commandExists(name)` | PATH lookup |
| `loadMachineEnv(repoRoot)`, `envValue(file, key)`, `expandHome`, `ensureConfigDir(ctx)` | Machine config |
| `curlGet`, `curlJson`, `curlRequest` | HTTP via curl |
| `portFree`, `choosePort(ctx, label, port, {envVars})`, `resolveHostPort(ctx, label)` | Ports; `resolveHostPort` reads the manifest `compose.hostPortEnv` and `defaultHostPort` |
| `composeArgs(ctx, ...rest)` | `docker compose` argv: project, optional `-f` files, optional `--profile` |
| `saveWizardConf(ctx, extra, {pmSections})` | Write `wizard.conf` (and `config.toml` sections); no-op in a dry run. Always includes `MEMORY_PROVIDER` |
| `runStackSetup(ctx, opts)` | Run `<packageRoot>/scripts/setup.mjs` against the stack root |
| `apiBase(ctx)` | The provider's resolved HTTP base URL |

## Manifest fields the meta wizard reads

```json
"compose": {
  "profile": "mem0",
  "files": ["compose.mem0.yaml"],
  "hostPortEnv": "MEM0_PORT",
  "defaultHostPort": 8000,
  "healthService": "mem0",
  "logServices": ["mem0"]
},
"wizard": { "recallHint": "check the server ({compose} logs mem0)" }
```

- `compose.profile` adds `--profile <name>`; `compose.files` adds `-f` flags after `compose.yaml`
  and after `compose.override.yaml` when that exists. Both apply to every compose call: `up`,
  `down`, `build`, `ps`, and the indexer run. Files must be inside the stack root (no absolute
  paths, no `..`). With neither field the command text is exactly what it was before.
- `compose.services` is documentation only: `up` is scoped by the profile, not by service list.
- The API base URL comes from `compose.hostPortEnv` and `defaultHostPort`, or from an `apiBase`
  hook. `ctx.apiUrl` (`--api-url`) wins over both.
- `wizard.recallHint` is the error hint when the smoke recall fails. `{compose}` expands to the
  full compose command prefix and `{project}` to the project name. Without it the generic
  message uses `compose.logServices` or `compose.healthService`.
- A provider with no model backend sets none of `MEMORY_BACKEND`, `MEMORY_MODEL`, ...; generic
  validation does not require them.

## Delegated commands (asdf-style)

A manifest may declare commands the provider owns outright:

```json
"wizardHooks": {
  "module": "wizard.mjs",
  "delegates": {
    "mem0-login": { "description": "Run mem0 CLI login", "run": ["mem0", "login"] }
  }
}
```

`./pm mem0-login` runs `run` with inherited stdio when that provider is active. Prefer delegates
over reimplementing provider CLIs in Node.

## Hindsight

Everything about LiteLLM routes, lemond, Ollama, custom OpenAI-compatible backends and the Clack
model prompts lives in `providers/hindsight/`:

| File | Role |
| --- | --- |
| `wizard.mjs` | Thin hook exports; re-exports `prepareStackEnv`, `migrateEnv`, `setupNotices` |
| `lib/state.mjs` | `ensureState`, backend defaults, `wizard.conf` reads |
| `lib/model-backend.mjs` | Backend choice (lemond / ollama / custom), reflect model, model pulls |
| `lib/litellm-routes.mjs` | Write the LiteLLM route file and `hindsight.env`; saves `wizard.conf` |
| `lib/probe.mjs` | Probe lemond/ollama endpoints and list models |
| `lib/config.mjs` | `defaultsFromConfig`, `applyConfigEnv`, `configToml` (`[stack]` ports, `[model]`) |
| `lib/ports.mjs` | `resolvePorts` for the API and control-plane ports |
| `lib/env-setup.mjs` | `stackEnv`, `setupEnv` (secrets, LiteLLM env) |
| `lib/stack-env.mjs` | `prepareStackEnv`, `migrateEnv`, `setupNotices` for `scripts/setup.mjs` |
| `lib/validate.mjs` | Hindsight validation (model backend, route file, ports) |
| `lib/summary.mjs` | Closing summary lines |
| `lib/coding-agent.mjs` | `~/.hindsight/coding-agent.json` link and opt-in paths check |
| `lib/clack.mjs` | `clackSetup`: backend and model prompts for the Clack front end |

Its `wizard.conf` keeps `MEMORY_PROVIDER`, `MEMORY_BACKEND`, `MEMORY_MODEL`, `MEMORY_API_BASE` and
`MEMORY_REFLECT_MODEL`. The manifest sets `compose.profile: "hindsight"`, so a
non-Hindsight provider never starts its services.

`configureModelRouting` takes `ctx.skipBackendStep` (`WIZARD_SKIP_BACKEND_STEP=1`) to skip the
prompts when Clack has already collected the answers.

## Loader

`wizard/lib/provider-wizard/run-steps.mjs`:

- `loadProviderWizard(manifest)`: import `providers/<id>/wizard.mjs`, cached per file; `{}` when absent
- `callProviderHook(ctx, phase, helpers)`: returns `{ ran, value }`; announces the announced phases
- `runProviderPhase(ctx, phase, helpers)`: the same, returning whether the hook ran
- `runDelegatedCommand`, `listDelegateCommands`: manifest `delegates`

## Tests

- `scripts/tests/test_provider_wizard_hooks.mjs`: helpers `apiVersion`, frozen helpers, hook loader,
  stubbed-helpers tests of the Hindsight `configureModelRouting` (`--yes`, `skipBackendStep`, the
  three backends), static checks (no provider imports `run-wizard.mjs`; no provider names in the
  meta files)
- `scripts/tests/test_provider_manifests.mjs`: manifest schema incl. `compose.profile`/`files`
- `scripts/tests/test_wizard.sh`: dry-run and real-run scenarios with a docker stub, including a
  provider with no hooks, a provider with every v2 hook (fixtures in
  `scripts/tests/fixtures/providers/`, selected with `PM_PROVIDERS_DIR`), and a package-root /
  stack-root split

## Adding hooks (checklist)

1. Add `wizardHooks.module` (and `compose.*`) to `manifest.json`
2. Create `providers/<id>/wizard.mjs`; implement only the phases you need
3. Keep provider state on `ctx` through `init`/`hydrate`; return `configToml`/`summary` data instead of writing in the meta files
4. Add `delegates` only when a native CLI must run on the host
5. Document native vs meta ownership in manifest `settings`
6. Extend the tests and the [add-memory-provider](../.agents/skills/add-memory-provider/SKILL.md) skill
