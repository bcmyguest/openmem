/**
 * mem0 sub-wizard (hook API v2), URL-only: the operator runs a mem0 REST server (see
 * https://docs.mem0.ai/open-source/features/rest-api) and this stack only points the shared
 * indexer at it. The wizard asks for the server URL and API key, keeps the key in a mode 600
 * env file (never the stack .env, wizard.conf or config.toml), and smoke tests the server.
 * See lib/ for the implementations and docs/provider-wizard-hooks.md for the hook contract.
 *
 * This module must not import wizard/lib/run-wizard.mjs; it receives `helpers`.
 */
import { applyConfig, configToml as buildConfigToml } from "./lib/config.mjs";
import { clackSetup as askInClack, configureUrlAndKey } from "./lib/configure.mjs";
import { smoke as mem0Smoke } from "./lib/smoke.mjs";
import { ensureState } from "./lib/state.mjs";
import { summary as mem0Summary } from "./lib/summary.mjs";
import { resolveApiUrl, resolvePorts as resolveMem0Url } from "./lib/url.mjs";
import { beforeStack as checkBeforeStack, validateMem0 } from "./lib/validate.mjs";

// Called by scripts/setup.mjs (the stack .env writer), not by the wizard.
export { prepareStackEnv, setupNotices } from "./lib/stack-env.mjs";

/** @typedef {import('../../wizard/lib/provider-wizard/helpers.mjs').ProviderWizardHelpers} Helpers */

/**
 * Quiet: seed ctx.mem0 and read the [memory.mem0] table (api_url, env_file).
 * @param {Record<string, any>} ctx
 */
export async function init(ctx) {
  ensureState(ctx);
  applyConfig(ctx);
}

/**
 * Quiet: remember the URL saved in wizard.conf for `--up`.
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export async function hydrate(ctx, h) {
  const state = ensureState(ctx);
  applyConfig(ctx);
  state.savedUrl = (h.envValue(ctx.wizardConf, "MEM0_API_URL") || "").trim();
}

/**
 * Quiet: the HOST view of the server URL. Without this hook the manifest's hostPortEnv
 * would derive http://127.0.0.1:<MEM0_PORT>, which is wrong for a remote server.
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 * @returns {string}
 */
export function apiBase(ctx, h) {
  return resolveApiUrl(ctx, h);
}

/**
 * Announced: there is no local port to choose. Validates the URL and exports
 * MEM0_API_URL so compose and scripts/setup.mjs see it.
 */
export const resolvePorts = resolveMem0Url;

/**
 * Announced step "URL, key and login": server URL, API key into the mode 600 env file.
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export async function configureModelRouting(ctx, h) {
  await configureUrlAndKey(ctx, h);
}

/**
 * Quiet: hand the URL to scripts/setup.mjs, which writes MEM0_API_URL, MEM0_INDEXER_URL,
 * COMPOSE_PROFILES and LITELLM_CONFIG into the stack .env. Never a secret.
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export function stackEnv(ctx, h) {
  return {
    description:
      "scripts/setup.sh: write .env (MEM0_API_URL, MEM0_INDEXER_URL, no secrets), compose.override.yaml",
    env: { MEM0_API_URL: resolveApiUrl(ctx, h) },
  };
}

/** Announced: warn (never fail) when the server is unreachable; check the env file mode. */
export const beforeStack = checkBeforeStack;

/** Announced: GET /docs, retain verbatim, search, delete (X-API-Key when a key exists). */
export const smoke = mem0Smoke;

/**
 * Announced: appends to ctx.validationErrors / ctx.validationChecks.
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export async function extendValidation(ctx, h) {
  validateMem0(ctx, h);
}

/**
 * Quiet: `[memory.mem0]` for config.toml (api_url, optional env_file; never a key).
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export function configToml(ctx, h) {
  return buildConfigToml(ctx, resolveApiUrl(ctx, h));
}

/**
 * Quiet: lines for the closing summary.
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export function summary(ctx, h) {
  return mem0Summary(ctx, h);
}

/**
 * Clack-only: ask the URL and the (masked) API key, return the environment that makes the
 * wizard skip its own prompts (WIZARD_SKIP_BACKEND_STEP).
 * @param {Record<string, any>} ctx
 * @param {typeof import("@clack/prompts")} ui
 * @param {Helpers} h
 */
export async function clackSetup(ctx, ui, h) {
  return askInClack(ctx, ui, h);
}
