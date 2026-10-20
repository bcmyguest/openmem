/**
 * Hindsight sub-wizard (hook API v2). Owns everything Hindsight-specific that the meta
 * wizard used to do inline: the lemond / Ollama / custom model flow and LiteLLM routes,
 * hindsight.env and litellm.env, the HINDSIGHT_PORT / HINDSIGHT_CP_PORT pair, Hindsight
 * validation, and the summary lines. See lib/ for the implementations and
 * docs/provider-wizard-hooks.md for the hook contract.
 *
 * This module must not import wizard/lib/run-wizard.mjs; it receives `helpers`.
 */
import { applyConfigEnv, configToml as buildConfigToml } from "./lib/config.mjs";
import { setupCodingAgent as linkCodingAgent } from "./lib/coding-agent.mjs";
import { clackSetup as askInClack } from "./lib/clack.mjs";
import { setupEnv as setupHindsightEnv, stackEnv as hindsightStackEnv } from "./lib/env-setup.mjs";
import { chooseModelBackend } from "./lib/model-backend.mjs";
import { ensureComposeOllamaModels } from "./lib/ollama-compose.mjs";
import { resolvePorts as resolveHindsightPorts } from "./lib/ports.mjs";
import { backendDefault, confGet, ensureState } from "./lib/state.mjs";
import { summary as hindsightSummary } from "./lib/summary.mjs";
import { validateHindsight } from "./lib/validate.mjs";

// Called by scripts/setup.mjs (the stack .env writer), not by the wizard.
export { migrateEnv, prepareStackEnv, setupNotices } from "./lib/stack-env.mjs";

/** @typedef {import('../../wizard/lib/provider-wizard/helpers.mjs').ProviderWizardHelpers} Helpers */

/**
 * Quiet: fill Hindsight's context fields, map [stack]/[model] TOML defaults into the
 * environment (including LEMOND_BASE from [model].lemond.host).
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export async function init(ctx, h) {
  ensureState(ctx);
  applyConfigEnv(ctx.pmMerged || {});
  if (process.env.LEMOND_BASE) ctx.lemondBase = process.env.LEMOND_BASE;
}

/**
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export async function afterProvider(ctx, h) {
  h.info("Hindsight uses LiteLLM aliases (memory-retain / reflect / consolidate).");
}

/**
 * Step "3. Model backend": lemond, Ollama or a custom OpenAI-compatible URL behind the
 * LiteLLM proxy.
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export async function configureModelRouting(ctx, h) {
  await chooseModelBackend(ctx, h);
}

/** Hindsight's API and control-plane ports. */
export const resolvePorts = resolveHindsightPorts;

/**
 * Quiet: description and environment for the stack setup script (scripts/setup.mjs).
 * @param {Record<string, any>} ctx
 */
export function stackEnv(ctx) {
  return hindsightStackEnv(ctx);
}

/** hindsight.env, litellm.env wiring. */
export const setupEnv = setupHindsightEnv;

/**
 * Quiet: reload the model choice from wizard.conf for `--up`.
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export async function hydrate(ctx, h) {
  ensureState(ctx);
  ctx.backend = confGet(ctx, h, "MEMORY_BACKEND") || backendDefault(ctx, h);
  ctx.model = confGet(ctx, h, "MEMORY_MODEL") || ctx.lemondDefaultModel;
  ctx.apiBase = confGet(ctx, h, "MEMORY_API_BASE") || "";
  ctx.reflectModel = confGet(ctx, h, "MEMORY_REFLECT_MODEL") || "";
  ctx.ollamaInCompose = confGet(ctx, h, "MEMORY_OLLAMA_IN_COMPOSE") === "1";
  applyComposeProfiles(ctx);
}

/**
 * Ensure compose profile `ollama` is on the up command when MEMORY_OLLAMA_IN_COMPOSE=1.
 * @param {Record<string, any>} ctx
 * @param {Helpers} _h
 */
export async function beforeStack(ctx, _h) {
  ensureState(ctx);
  applyComposeProfiles(ctx);
}

/**
 * Pull models into compose Ollama after the stack is up (host has no ollama CLI).
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export async function afterStackHealthy(ctx, h) {
  await ensureComposeOllamaModels(ctx, h);
}

/** @param {Record<string, any>} ctx */
function applyComposeProfiles(ctx) {
  const extra = [...(ctx.extraComposeProfiles || [])];
  if (ctx.ollamaInCompose && !extra.includes("ollama")) extra.push("ollama");
  ctx.extraComposeProfiles = extra;
}

/**
 * Quiet: tables merged into config.toml.
 * @param {Record<string, any>} ctx
 */
export function configToml(ctx) {
  ensureState(ctx);
  return buildConfigToml(ctx);
}

/**
 * Quiet: lines for the closing summary.
 * @param {Record<string, any>} ctx
 */
export function summary(ctx) {
  return hindsightSummary(ctx);
}

/**
 * Appends to ctx.validationErrors / ctx.validationChecks after the shared checks.
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export async function extendValidation(ctx, h) {
  validateHindsight(ctx, h);
}

/** Link ~/.hindsight/coding-agent.json and check optInPaths. */
export const setupCodingAgent = linkCodingAgent;

/**
 * Clack-only: ask the model questions, return the environment that makes the wizard
 * skip its own (see WIZARD_SKIP_BACKEND_STEP).
 * @param {Record<string, any>} ctx
 * @param {typeof import("@clack/prompts")} ui
 * @param {Helpers} h
 */
export async function clackSetup(ctx, ui, h) {
  return askInClack(ctx, ui, h);
}
