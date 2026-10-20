/**
 * The stack-env handoff and the pre-start step for Cognee.
 *
 * stackEnv: what the generic stack setup script (scripts/setup.mjs) prints and receives.
 *   It writes COGNEE_PORT, COMPOSE_PROFILES and LITELLM_CONFIG into the stack .env (see
 *   lib/stack-env.mjs); no secret ever goes there.
 * beforeStack: the env directories must exist before scripts/gen-masks.mjs runs, because
 *   it only masks directories that exist; a masked ~/.config/personal-memory keeps
 *   cognee.env out of the indexer's read-only $HOME mount.
 */
import fs from "node:fs";
import path from "node:path";
import { ensurePrivateDir, tooOpen } from "./env-file.mjs";
import { currentPort, ensureState } from "./state.mjs";

/** @typedef {import("../../../wizard/lib/provider-wizard/helpers.mjs").ProviderWizardHelpers} Helpers */

/**
 * @param {Record<string, any>} ctx
 * @returns {{ description: string, env: Record<string, string> }}
 */
export function stackEnv(ctx) {
  ensureState(ctx);
  return {
    description:
      "scripts/setup.sh: write .env (COGNEE_PORT, COMPOSE_PROFILES) and compose.override.yaml",
    env: { COGNEE_PORT: currentPort(ctx) },
  };
}

/**
 * Create the directories of the env files with mode 0700 and warn about loose modes.
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export async function beforeStack(ctx, h) {
  ensureState(ctx);
  const files = [...new Set([ctx.cognee.envFile, ctx.cognee.indexerEnvFile])];
  for (const dir of new Set(files.map((f) => path.dirname(f)))) {
    if (ctx.dry && !fs.existsSync(dir)) {
      h.info(`[dry-run] create ${dir} (mode 700, holds the Cognee env files)`);
      continue;
    }
    if (!ctx.dry && ensurePrivateDir(dir)) h.ok(`created ${dir} (mode 700)`);
    else if (fs.statSync(dir).mode & 0o077) {
      h.warn(`${dir} is readable by other users; the env files inside are mode 600, but consider: chmod 700 ${dir}`);
    }
  }
  for (const file of files) {
    if (fs.existsSync(file) && tooOpen(file)) {
      h.warn(`${file} is readable by other users (it may hold API keys); run: chmod 600 ${file}`);
    }
  }
}
