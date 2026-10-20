import fs from "node:fs";
import path from "node:path";
import { envValue, indexerStateDir } from "./paths.mjs";
import { DEFAULT_PROVIDER_ID, listAllProviders, validateManifest } from "./providers/registry.mjs";

/**
 * Provider-neutral checks: manifest validity, wizard.conf, the stack .env host ids,
 * index.yml and the shared indexer state dir. Provider checks come from the provider's
 * `extendValidation` hook, which appends to ctx.validationErrors / ctx.validationChecks.
 *
 * @param {import("./run-wizard.mjs").WizardContext} ctx
 * @returns {{ ok: boolean, errors: string[], checks: string[] }}
 */
export function validateMemorySetup(ctx) {
  const errors = [];
  const checks = [];

  if (ctx.memoryProvider) {
    for (const e of validateManifest(ctx.memoryProvider)) {
      errors.push(`manifest ${ctx.memoryProvider.id}: ${e}`);
    }
  }

  if (!fs.existsSync(ctx.wizardConf)) {
    errors.push(`missing ${ctx.wizardConf}`);
  } else {
    const provider = envValue(ctx.wizardConf, "MEMORY_PROVIDER") || DEFAULT_PROVIDER_ID;
    checks.push(`wizard.conf MEMORY_PROVIDER=${provider}`);
    if (ctx.memoryProvider && provider !== ctx.memoryProvider.id) {
      errors.push(
        `wizard.conf MEMORY_PROVIDER=${provider} does not match active ${ctx.memoryProvider.id}`,
      );
    }
  }

  const stackEnv = path.join(ctx.repoRoot, ".env");
  if (!fs.existsSync(stackEnv)) errors.push(`missing repo ${stackEnv}`);
  else {
    for (const key of ["HOST_UID", "HOST_GID"]) {
      if (!envValue(stackEnv, key)) errors.push(`repo .env missing ${key}`);
    }
    checks.push("repo .env host ids");
  }

  if (!fs.existsSync(ctx.indexFile)) errors.push(`missing ${ctx.indexFile}`);
  else checks.push("index.yml present");

  const stateDir = indexerStateDir(ctx);
  if (!fs.existsSync(stateDir)) errors.push(`missing indexer state dir ${stateDir}`);
  else checks.push("indexer state mount point");

  return { ok: errors.length === 0, errors, checks };
}

/** @returns {{ ok: boolean, errors: string[] }} */
export function validateAllProviderManifests() {
  const errors = [];
  for (const m of listAllProviders()) {
    for (const e of validateManifest(m)) errors.push(`${m.id}: ${e}`);
  }
  return { ok: errors.length === 0, errors };
}
