---
name: add-memory-provider
description: >-
  Add a new memory provider plugin to personal-memory (providers/*/manifest.json,
  indexer sink, compose, wizard smoke steps). Use when implementing mem0 or another
  non-Hindsight memory backend.
---

# Add a memory provider

Read [docs/memory-providers.md](../../docs/memory-providers.md) first — especially **Meta setup wizard**.
This repo is a **meta** orchestrator; do not reimplement the provider’s native settings UI. Hindsight is
the reference implementation under `providers/hindsight/`.

## Checklist

1. **Manifest** — Create `providers/<id>/manifest.json`:
   - `settings.nativeDocs`, `settings.nativeConfigPaths`, `settings.wizardOwns` — document what users
     still configure in the provider’s own tools vs what `./setup` handles.
   - `status`: start as `experimental`, move to `supported` when complete.
   - `compose`: services, `healthPath`, `hostPortEnv`, `defaultHostPort`.
   - `indexer`: `apiUrlEnv`, `sinkDriver` (must match Python sink module name later).
   - `wizard`: full smoke test paths (`retainPath`, `recallPath`, `deletePath`, bodies, `recallMustMatch`).
   - `codingAgent`: `pluginPackage` and `configTemplate` when known; use `null` if N/A.

2. **Validate** — Run:
   ```bash
   node scripts/tests/test_provider_manifests.mjs
   ```
   Supported/experimental manifests must pass `validateManifest()` in
   `wizard/lib/providers/registry.mjs`.

3. **Indexer sink** (Phase B in docs) — Add `indexer/sinks/<driver>.py` and wire
   `bin/hindsight-project-index` (or renamed entry) to call the sink selected by
   `MEMORY_PROVIDER` / manifest `indexer.sinkDriver`.

4. **Compose** — Add services or document external URL-only mode. Update
   `docs/memory-providers.md` with ports and env vars.

5. **Wizard** — Provider appears automatically in `./setup` when `status` is not `planned`.
   Confirm Clack lists it and `--yes` works with `MEMORY_PROVIDER=<id>`.

6. **Setup validation** — Extend `wizard/lib/validate-setup.mjs` with any provider-specific
   checks (API URL, auth files, etc.). Add cases to `scripts/tests/test_memory_setup.mjs`.

7. **Tests** — Extend `scripts/tests/test_wizard.sh` or add provider-specific tests with
   stubbed HTTP/docker. Never hit the operator's live stack.

8. **README** — Link the provider and note coding-agent install differences.

9. **TOML** — Document provider-specific tables under `[memory.<id>]` in
   [docs/personal-memory-config.md](../../docs/personal-memory-config.md); extend
   `wizard/lib/pm-config.mjs` if new top-level keys are needed.

10. **Sub-wizard** — Add `providers/<id>/wizard.mjs` and `wizardHooks` in the manifest.
    Follow [docs/provider-wizard-hooks.md](../../docs/provider-wizard-hooks.md): implement
    `configureModelRouting`, `beforeStack`, etc.; use `delegates` for native CLIs (asdf-style).

## Do not

- Ship `status: supported` without smoke paths and validation coverage.
- Hard-code provider id strings in multiple files; use manifest + registry.
- Break Hindsight defaults (`MEMORY_PROVIDER` unset → `hindsight`).
