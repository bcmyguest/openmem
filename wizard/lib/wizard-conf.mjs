import fs from "node:fs";
import { ensureHsDir, envValue } from "./paths.mjs";
import { syncPmConfig } from "./pm-config.mjs";
import { DEFAULT_PROVIDER_ID } from "./providers/registry.mjs";

/** Meta keys owned outside provider extras; rewrite keeps them unless `extra` overrides. */
const META_KEYS = ["NOTEBOOKLM_HOME"];

/**
 * Write wizard.conf (MEMORY_PROVIDER plus provider-owned keys) and the mise-like
 * config.toml. Does nothing in a dry run; callers print their own dry-run line.
 * Preserves meta keys already on disk (for example NOTEBOOKLM_HOME) when not in `extra`.
 *
 * @param {import("./run-wizard.mjs").WizardContext} ctx
 * @param {Record<string, string>} [extra] provider keys, written after MEMORY_PROVIDER in order
 * @param {{ pmSections?: Record<string, Record<string, unknown>> }} [opts]
 */
export function writeWizardConf(ctx, extra = {}, opts = {}) {
  if (ctx.dry) return;
  ensureHsDir(ctx);
  /** @type {Record<string, string>} */
  const preserved = {};
  if (fs.existsSync(ctx.wizardConf)) {
    for (const key of META_KEYS) {
      if (key in extra) continue;
      const v = envValue(ctx.wizardConf, key);
      if (v) preserved[key] = v;
    }
  }
  const providerId = ctx.memoryProvider?.id || DEFAULT_PROVIDER_ID;
  let body = `MEMORY_PROVIDER=${providerId}\n`;
  for (const [key, value] of Object.entries({ ...preserved, ...extra })) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`invalid wizard.conf key: ${key}`);
    body += `${key}=${String(value ?? "").replace(/[\r\n]+/g, " ")}\n`;
  }
  fs.writeFileSync(ctx.wizardConf, body, { mode: 0o644 });
  ctx.wizardConfWritten = true;
  syncPmConfig(ctx, opts.pmSections || {});
}

/**
 * Merge keys into the existing wizard.conf without dropping MEMORY_PROVIDER or other lines.
 * Does nothing in a dry run.
 *
 * @param {import("./run-wizard.mjs").WizardContext} ctx
 * @param {Record<string, string>} updates
 */
export function upsertWizardConf(ctx, updates) {
  if (ctx.dry) return;
  ensureHsDir(ctx);
  /** @type {Record<string, string>} */
  const keys = {};
  if (fs.existsSync(ctx.wizardConf)) {
    for (const line of fs.readFileSync(ctx.wizardConf, "utf8").split("\n")) {
      const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
      if (m) keys[m[1]] = m[2];
    }
  }
  const providerId = ctx.memoryProvider?.id || keys.MEMORY_PROVIDER || DEFAULT_PROVIDER_ID;
  for (const [key, value] of Object.entries(updates)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`invalid wizard.conf key: ${key}`);
    keys[key] = String(value ?? "").replace(/[\r\n]+/g, " ");
  }
  keys.MEMORY_PROVIDER = providerId;
  let body = `MEMORY_PROVIDER=${providerId}\n`;
  for (const [key, value] of Object.entries(keys)) {
    if (key === "MEMORY_PROVIDER") continue;
    body += `${key}=${value}\n`;
  }
  fs.writeFileSync(ctx.wizardConf, body, { mode: 0o644 });
}
