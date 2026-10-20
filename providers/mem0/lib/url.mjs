/**
 * The mem0 server URL as the operator's host sees it: resolution order, validation (the
 * same rules as scripts/setup.mjs, through `indexerUrl`) and the announced
 * `resolvePorts` step. mem0 has no local port to pick.
 */
import path from "node:path";
import * as stackEnv from "./stack-env.mjs";
import { DEFAULT_API_URL, ensureState, envFileProblem, resolveEnvFile, defaultEnvFile } from "./state.mjs";

/** @typedef {import("../../../wizard/lib/provider-wizard/helpers.mjs").ProviderWizardHelpers} Helpers */

/** @param {string} url */
function stripSlash(url) {
  return url.replace(/\/+$/, "");
}

/**
 * The host-view URL: --api-url (ctx.apiUrl), MEM0_API_URL, PM_MEM0_API_URL, the context
 * value ([memory.mem0] api_url), the stack .env, wizard.conf, then the default. Not
 * validated; callers check it with `urlProblem`.
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 * @returns {string}
 */
export function resolveApiUrl(ctx, h) {
  const state = ensureState(ctx);
  const stackEnvFile = ctx.repoRoot ? path.join(ctx.repoRoot, ".env") : "";
  const candidates = [
    ctx.apiUrl,
    process.env.MEM0_API_URL,
    process.env.PM_MEM0_API_URL,
    state.apiUrl,
    stackEnvFile && h.envValue(stackEnvFile, "MEM0_API_URL"),
    state.savedUrl || (ctx.wizardConf && h.envValue(ctx.wizardConf, "MEM0_API_URL")),
  ];
  const first = candidates.map((v) => String(v || "").trim()).find(Boolean);
  return stripSlash(first || DEFAULT_API_URL);
}

/**
 * What is wrong with a URL, or "". The message never echoes the URL (it may hold a secret).
 * @param {string} url
 * @returns {string}
 */
export function urlProblem(url) {
  try {
    stackEnv.indexerUrl(url);
    return "";
  } catch (e) {
    return /** @type {Error} */ (e).message;
  }
}

/**
 * The URL in the form the stack .env stores (validated first, so no secret can be in it).
 * @param {string} url
 */
export function displayUrl(url) {
  try {
    return typeof stackEnv.normalizeHostUrl === "function" ? stackEnv.normalizeHostUrl(url) : stripSlash(url);
  } catch {
    return stripSlash(url);
  }
}

/**
 * Container view of the URL, or "" when it does not validate.
 * @param {string} url
 */
export function containerUrl(url) {
  try {
    return stackEnv.indexerUrl(url);
  } catch {
    return "";
  }
}

/**
 * Announced: validate the URL and export MEM0_API_URL (and a non-default env file) so
 * compose and scripts/setup.mjs see them. No port probing: the server is external.
 * A stop (`--down`) skips it so a bad URL never blocks shutting the stack down.
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export async function resolvePorts(ctx, h) {
  const state = ensureState(ctx);
  if (ctx.action === "down") return;
  const raw = resolveApiUrl(ctx, h);
  const problem = urlProblem(raw);
  if (problem) {
    h.problem(ctx, `mem0 API URL: ${problem}`);
    return;
  }
  const url = displayUrl(raw);
  state.url = url;
  process.env.MEM0_API_URL = url;
  const envFile = resolveEnvFile(ctx, h);
  const fileProblem = envFileProblem(envFile);
  if (fileProblem) {
    h.problem(ctx, fileProblem);
    return;
  }
  // The indexer's env_file path is interpolated by compose from the process environment.
  if (envFile !== defaultEnvFile(ctx.home)) process.env.MEM0_ENV_FILE = envFile;
  h.ok(`mem0 server ${url} (external; no local port to check)`);
}
