/**
 * Cognee sub-wizard (hook API v2). Cognee runs as a pinned docker service on a loopback
 * port in single-user mode; its secrets (LLM_API_KEY) live in an operator env file outside
 * the repo (default ~/.config/personal-memory/cognee.env), never in the stack .env,
 * wizard.conf, config.toml, the summary or an error message. See lib/ for the
 * implementations and docs/provider-wizard-hooks.md for the hook contract.
 *
 * This module must not import wizard/lib/run-wizard.mjs; it receives `helpers`.
 */
import { applyConfig, configToml as buildConfigToml } from "./lib/config.mjs";
import { clackSetup as askInClack } from "./lib/clack.mjs";
import { beforeStack as prepareEnvDirs, stackEnv as cogneeStackEnv } from "./lib/env-setup.mjs";
import { configureLlm } from "./lib/llm-env.mjs";
import { resolvePorts as resolveCogneePorts } from "./lib/ports.mjs";
import { runSmoke } from "./lib/smoke.mjs";
import { ensureState } from "./lib/state.mjs";
import { summary as cogneeSummary } from "./lib/summary.mjs";
import { validateCognee } from "./lib/validate.mjs";

// Called by scripts/setup.mjs (the stack .env writer), not by the wizard.
export { prepareStackEnv, setupNotices } from "./lib/stack-env.mjs";

/** @typedef {import('../../wizard/lib/provider-wizard/helpers.mjs').ProviderWizardHelpers} Helpers */

/**
 * Quiet: fill Cognee's context fields and map the `[memory.cognee]` TOML table
 * (port, env_file) into the environment when the environment did not set them.
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export async function init(ctx, h) {
  applyConfig(ctx, h);
}

/**
 * Quiet: restore the saved port from wizard.conf for `--up`. Nothing secret is saved.
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export async function hydrate(ctx, h) {
  ensureState(ctx);
  const saved = h.envValue(ctx.wizardConf, "COGNEE_PORT");
  if (/^\d+$/.test(saved) && !process.env.COGNEE_PORT) process.env.COGNEE_PORT = saved;
}

/** The single host port (COGNEE_PORT, default 8766). */
export const resolvePorts = resolveCogneePorts;

/**
 * Step "LLM key": write LLM_API_KEY (and the optional LLM and EMBEDDING settings given
 * as PM_COGNEE_<NAME>) into the operator env file. Never fails for a missing key: documents
 * are stored but not searchable until the key works.
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export async function configureModelRouting(ctx, h) {
  await configureLlm(ctx, h);
}

/**
 * Quiet: description and environment for the stack setup script (scripts/setup.mjs).
 * @param {Record<string, any>} ctx
 */
export function stackEnv(ctx) {
  return cogneeStackEnv(ctx);
}

/**
 * Create the env directories (mode 700) before the stack setup masks them; warn about
 * loose modes.
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export async function beforeStack(ctx, h) {
  await prepareEnvDirs(ctx, h);
}

/**
 * Replaces the manifest smoke test: health, create dataset, multipart add, list, delete.
 * Recall is not checked (ingestion is asynchronous).
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export async function smoke(ctx, h) {
  await runSmoke(ctx, h);
}

/**
 * Appends to ctx.validationErrors / ctx.validationChecks after the shared checks.
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export async function extendValidation(ctx, h) {
  validateCognee(ctx, h);
}

/**
 * Quiet: tables merged into config.toml (`[memory.cognee]`: port, env_file; no secrets).
 * @param {Record<string, any>} ctx
 */
export function configToml(ctx) {
  return buildConfigToml(ctx);
}

/**
 * Quiet: lines for the closing summary.
 * @param {Record<string, any>} ctx
 */
export function summary(ctx) {
  return cogneeSummary(ctx);
}

/**
 * Clack-only: ask for the LLM key with a hidden prompt; the answer reaches the wizard as
 * PM_COGNEE_LLM_API_KEY in its own process environment.
 * @param {Record<string, any>} ctx
 * @param {typeof import("@clack/prompts")} ui
 * @param {Helpers} h
 */
export async function clackSetup(ctx, ui, h) {
  return askInClack(ctx, ui, h);
}
