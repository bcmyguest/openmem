---
name: update-memory-provider-compatibility
description: >-
  Update openmem when a memory provider changes API, env vars, compose, or
  coding-agent integration. Use for Hindsight upgrades, mem0 API drift, or cross-provider fixes.
---

# Update memory provider compatibility

Use this when an **existing** provider breaks or upstream changes (Hindsight image bump, mem0 API,
LiteLLM routes, coding-agent plugin). Adding a brand-new provider is
[add-memory-provider](../add-memory-provider/SKILL.md).

## Where provider behavior lives

| Concern | Location |
| --- | --- |
| Plugin catalog | `providers/<id>/manifest.json` |
| Loader / validation | `wizard/lib/providers/registry.mjs`, `wizard/lib/validate-setup.mjs` |
| Interactive selection | `wizard/lib/run-clack.mjs`, `wizard/lib/run-wizard.mjs` (`chooseProvider`) |
| Stack lifecycle | `wizard/lib/run-wizard.mjs` (`startStack`, `stackDown`, actions `up`/`down`) |
| Indexer HTTP | `bin/hindsight-project-index` (→ future `indexer/sinks/*`) |
| Compose | `compose.yaml`, provider-specific overlays |
| Agent UX | `config/coding-agent.json`, manifest `codingAgent` fields |

## Workflow

1. **Identify the provider** — `MEMORY_PROVIDER` in `~/.config/hindsight/wizard.conf` or
   `config/machine.env`.

2. **Read the manifest** — Compare `providers/<id>/manifest.json` to the new upstream docs.
   Update `wizard` smoke paths if retain/recall URLs changed.

3. **Run tests before and after**:
   ```bash
   bash scripts/tests/test_wizard.sh
   node scripts/tests/test_provider_manifests.mjs
   node scripts/tests/test_memory_setup.mjs
   ```

4. **Wizard compatibility** — If health or smoke URLs change, update manifest and re-run wizard
   tests. If env file keys change, update `scripts/setup.mjs` and `validate-setup.mjs`.

5. **Indexer** — If document/bank IDs or HTTP shape changed, update sync logic and indexer tests
   under `indexer/tests/`.

6. **Coding-agent** — If `pluginPackage` or `apiUrl` in `config/coding-agent.json` changed,
   update manifest and README; document migration for users (re-run `./setup` or manual symlink).

7. **Cross-provider** — Changes shared by all providers (ports, gen-masks, machine.env) belong in
   shared wizard/setup code, not duplicated per manifest.

## Validation contract

After changes, a full `./setup --yes` on a scratch `HOME` must end with
`memory setup validation passed` (see `wizard/lib/validate-setup.mjs`). Extend validation when
new required files or env keys appear.

## Commits

Keep provider-specific diffs scoped: manifest + sink + tests in one commit; unrelated wizard UI
in another.
