import fs from "node:fs";
import { ensureHsDir } from "./paths.mjs";
import { syncPmConfig } from "./pm-config.mjs";
import { DEFAULT_PROVIDER_ID } from "./providers/registry.mjs";

/**
 * Write wizard.conf (MEMORY_PROVIDER plus provider-owned keys) and the mise-like
 * config.toml. Does nothing in a dry run; callers print their own dry-run line.
 *
 * @param {import("./run-wizard.mjs").WizardContext} ctx
 * @param {Record<string, string>} [extra] provider keys, written after MEMORY_PROVIDER in order
 * @param {{ pmSections?: Record<string, Record<string, unknown>> }} [opts]
 */
export function writeWizardConf(ctx, extra = {}, opts = {}) {
  if (ctx.dry) return;
  ensureHsDir(ctx);
  const providerId = ctx.memoryProvider?.id || DEFAULT_PROVIDER_ID;
  let body = `MEMORY_PROVIDER=${providerId}\n`;
  for (const [key, value] of Object.entries(extra)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`invalid wizard.conf key: ${key}`);
    body += `${key}=${String(value ?? "").replace(/[\r\n]+/g, " ")}\n`;
  }
  fs.writeFileSync(ctx.wizardConf, body, { mode: 0o644 });
  ctx.wizardConfWritten = true;
  syncPmConfig(ctx, opts.pmSections || {});
}
