# Provider wizard hooks (sub-wizards)

The meta wizard (`./setup`, `./pm`) owns cross-provider steps. Each **provider plugin** may
ship a **`providers/<id>/wizard.mjs`** module — the same relationship as **asdf/mise plugins**:
the core tool runs `bin/install`, `bin/list-all`, etc.; it does not reimplement Node, Rust, or mem0.

## Execution order (step registry)

Fixed **meta** phases run in order. **Provider** phases are inserted at anchors (declared in
`manifest.json` → `wizardHooks` or implied by the hook module).

```
meta.preflight
meta.provider          ← pick memory provider (Clack / TOML / --yes)
provider.afterProvider   ← optional hook
provider.configureModelRouting   ← LLM routes, API keys, mem0 login, etc.
meta.secrets             ← shared .env, litellm.env, gen-masks (Hindsight stack)
meta.index               ← shared index.yml
meta.notebooklm          ← optional profile
provider.beforeStack     ← provider compose fragments, migrations
meta.stack               ← build/up, health, smoke (smoke paths from manifest)
provider.afterStack      ← post-start checks, print native “open dashboard” URLs
meta.codingAgent         ← npx plugin when manifest defines one
meta.validate            ← validateMemorySetup()
provider.validate        ← provider-specific doctor checks
meta.syncConfig          ← write wizard.conf + config.toml
```

**Stack-only actions** (`./setup --up`, `./pm up`) skip configure phases and run:

```
meta.preflight → meta.provider → provider.beforeStack → meta.stack → provider.afterStack → meta.validate
```

**Down** runs `meta.preflight → meta.stackDown` (no provider hooks unless `provider.beforeDown` is added later).

## Hook module contract

Path: **`providers/<id>/wizard.mjs`** (ESM). Referenced by manifest:

```json
"wizardHooks": {
  "module": "wizard.mjs"
}
```

Export **optional async functions** named after registry phases (only implement what you need):

| Export | When it runs |
| --- | --- |
| `afterProvider` | Right after user/TOML selects this provider |
| `configureModelRouting` | Replace generic “model backend” for this provider |
| `beforeStack` | After shared secrets/index, before `docker compose up` |
| `afterStackHealthy` | After health + smoke |
| `extendValidation` | After shared validate; add errors to `ctx.validationErrors` |
| `runDelegatedCommand` | `./pm <provider-cmd>` or manifest `delegates` |

Second argument **`helpers`** (meta wizard API — stable, versioned):

```javascript
/**
 * @param {import('../../wizard/lib/run-wizard.mjs').WizardContext} ctx
 * @param {import('../../wizard/lib/provider-wizard/helpers.mjs').ProviderWizardHelpers} helpers
 */
export async function configureModelRouting(ctx, helpers) {
  await helpers.chooseBackend(ctx); // hindsight today; logic moves here over time
}
```

**Do not** import `./setup` or create circular imports from `run-wizard.mjs` into provider code
except through `helpers`.

## Delegated commands (asdf-style)

Manifest may declare commands the provider owns outright:

```json
"wizardHooks": {
  "module": "wizard.mjs",
  "delegates": {
    "mem0-login": {
      "description": "Run mem0 CLI login (native tool)",
      "run": ["mem0", "login"]
    }
  }
}
```

Meta wizard **`./pm mem0-login`** (future) execs `run` with `stdio: inherit` when provider is active
— like `asdf install nodejs` calling the plugin script. Prefer **delegates** over reimplementing
provider CLIs in Node.

## Hindsight today

`providers/hindsight/wizard.mjs` implements `configureModelRouting` by calling
`helpers.chooseBackend` (LiteLLM + lemond/Ollama/custom). That logic **migrates** into the hindsight
module over time; meta wizard stops knowing about lemond.

## mem0 (planned)

`providers/mem0/wizard.mjs` will implement `configureModelRouting` (API URL, key env),
`beforeStack` (optional sidecar), and `delegates.mem0-login`. No `[model]` lemond fields in TOML for
mem0-only machines — use `[memory.mem0]` (see [personal-memory-config.md](personal-memory-config.md)).

## Loader

`wizard/lib/provider-wizard/run-steps.mjs`:

- Resolves `providers/<id>/wizard.mjs` from manifest
- `runProviderPhase(ctx, phase, helpers)` — calls export or `helpers.fallback`
- Dynamic `import()` with cache bust per provider id

## Tests

- `scripts/tests/test_provider_wizard_hooks.mjs` — hindsight module loads; mem0 stub exports expected phases
- Wizard integration: configure dry-run still hits `configureModelRouting`

## Adding hooks (checklist)

1. Add `wizardHooks.module` to `manifest.json`
2. Create `providers/<id>/wizard.mjs` with phase exports
3. Move provider-specific logic out of `run-wizard.mjs` into the module via helpers
4. Add `delegates` only when a native CLI must run on the host
5. Document native vs meta ownership in manifest `settings`
6. Extend tests and [add-memory-provider](../.agents/skills/add-memory-provider/SKILL.md) skill
