/**
 * mem0 wizard state on the context object, the default URL, and the API key file path.
 * mem0 v1 is URL-only: the operator runs a mem0 REST server and this stack points the
 * indexer at it.
 */
import path from "node:path";

/** A stock mem0 server publishes 8888, the Hindsight default; this repo avoids it. */
export const DEFAULT_API_URL = "http://127.0.0.1:18888";

/** @typedef {import("../../../wizard/lib/provider-wizard/helpers.mjs").ProviderWizardHelpers} Helpers */

/**
 * Fill the mem0 fields of the wizard context. Idempotent: a field that is already set
 * (TOML mapping in `init`, a test) is kept.
 * @param {Record<string, any>} ctx
 */
export function ensureState(ctx) {
  const state = (ctx.mem0 ||= {});
  const defaults = {
    // [memory.mem0] api_url / env_file, filled by the init hook.
    apiUrl: "",
    tomlEnvFile: "",
    // wizard.conf value, filled by the hydrate hook.
    savedUrl: "",
    // The validated host-view URL this run uses, set by resolvePorts / configureModelRouting.
    url: "",
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (state[key] === undefined) state[key] = value;
  }
  return state;
}

/** @param {string} home */
export function defaultEnvFile(home) {
  return path.join(home || "", ".config/personal-memory/mem0.env");
}

/**
 * The file that holds MEM0_API_KEY for the indexer: MEM0_ENV_FILE, then [memory.mem0]
 * env_file, then ~/.config/personal-memory/mem0.env.
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export function resolveEnvFile(ctx, h) {
  const state = ensureState(ctx);
  const raw = (process.env.MEM0_ENV_FILE || state.tomlEnvFile || "").trim();
  if (!raw) return defaultEnvFile(ctx.home);
  return h.expandHome(raw, ctx.home);
}

/**
 * What is wrong with an env file path, or "". Compose interpolates the path in the
 * indexer's `env_file`, so it must be absolute and free of control characters and '$'.
 * @param {string} file
 */
export function envFileProblem(file) {
  if (!path.isAbsolute(file)) return "the mem0 env file path must be absolute (MEM0_ENV_FILE or env_file)";
  if (/[\x00-\x1f\x7f$]/.test(file)) {
    return "the mem0 env file path must not contain control characters or '$'";
  }
  return "";
}
