/**
 * The stack-env handoff and the pre-start step for Cognee.
 *
 * stackEnv: what the generic stack setup script (scripts/setup.mjs) prints and receives.
 *   It writes COGNEE_PORT, COMPOSE_PROFILES and LITELLM_CONFIG into the stack .env (see
 *   lib/stack-env.mjs), plus the PATHS of env files at a non-default location; no secret
 *   and no env file content ever goes there.
 * beforeStack: the env directories must exist before scripts/gen-masks.mjs runs, because
 *   it only masks directories that exist; a masked ~/.config/personal-memory keeps
 *   cognee.env out of the indexer's read-only $HOME mount.
 */
import fs from "node:fs";
import path from "node:path";
import { ensurePrivateDir, tooOpen } from "./env-file.mjs";
import { currentPort, ensureState, isCustomPath } from "./state.mjs";

/** @typedef {import("../../../wizard/lib/provider-wizard/helpers.mjs").ProviderWizardHelpers} Helpers */

/**
 * @param {Record<string, any>} ctx
 * @returns {{ description: string, env: Record<string, string> }}
 */
export function stackEnv(ctx) {
  ensureState(ctx);
  /** @type {Record<string, string>} */
  const env = { COGNEE_PORT: currentPort(ctx) };
  if (isCustomPath(ctx, "envFile")) env.COGNEE_ENV_FILE = ctx.cognee.envFile;
  if (isCustomPath(ctx, "indexerEnvFile")) env.COGNEE_INDEXER_ENV_FILE = ctx.cognee.indexerEnvFile;
  return {
    description:
      "scripts/setup.sh: write .env (COGNEE_PORT, COMPOSE_PROFILES) and compose.override.yaml",
    env,
  };
}

/**
 * True when `file` sits under $HOME but outside ~/.config/personal-memory, the one directory
 * scripts/gen-masks.mjs hides from the indexer's $HOME mount for these files.
 * @param {Record<string, any>} ctx
 * @param {string} file
 */
function isUnmasked(ctx, file) {
  if (!ctx.home) return false;
  const inside = (/** @type {string} */ dir, /** @type {string} */ p) => p.startsWith(`${dir}${path.sep}`);
  return inside(ctx.home, file) && !inside(path.join(ctx.home, ".config/personal-memory"), file);
}

/**
 * Create the directories of the env files with mode 0700, tighten a group- or
 * other-readable env file to 0600 (a real run), and warn about env files the indexer's
 * $HOME mount could expose.
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
      if (ctx.dry) h.warn(`${file} is readable by other users (it may hold API keys); a real run sets mode 600`);
      else {
        fs.chmodSync(file, 0o600);
        h.ok(`tightened ${file} to mode 600 (it may hold API keys)`);
      }
    }
    if (isUnmasked(ctx, file)) {
      h.warn(
        `${file} is under your home directory but outside ~/.config/personal-memory, which the indexer's ` +
          "read-only $HOME mount does not mask; the indexer container could read it. Move it into that directory.",
      );
    }
  }
}
