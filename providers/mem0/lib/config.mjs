/**
 * mem0's slice of ~/.config/personal-memory/config.toml: the [memory.mem0] table
 * (api_url, optional env_file). Never a key.
 */
import { ensureState } from "./state.mjs";

/**
 * @param {Record<string, unknown>} cfg merged TOML config
 * @returns {{ apiUrl: string, envFile: string }}
 */
export function defaultsFromConfig(cfg) {
  const memory = /** @type {Record<string, unknown>} */ (cfg?.memory || {});
  const mem0 = /** @type {Record<string, unknown>} */ (memory.mem0 || {});
  return {
    apiUrl: mem0.api_url != null ? String(mem0.api_url).trim() : "",
    envFile: mem0.env_file != null ? String(mem0.env_file).trim() : "",
  };
}

/**
 * Seed ctx.mem0 from [memory.mem0]. Env vars still win over these (see resolveApiUrl).
 * @param {Record<string, any>} ctx
 */
export function applyConfig(ctx) {
  const state = ensureState(ctx);
  const d = defaultsFromConfig(ctx.pmMerged || {});
  if (d.apiUrl && !state.apiUrl) state.apiUrl = d.apiUrl;
  if (d.envFile && !state.tomlEnvFile) state.tomlEnvFile = d.envFile;
}

/**
 * Tables merged into config.toml: `memory.mem0`, which the wizard merges into [memory] (it
 * always sets `provider` itself).
 * @param {Record<string, any>} ctx
 * @param {string} url the resolved host-view server URL
 * @returns {Record<string, Record<string, unknown>>}
 */
export function configToml(ctx, url) {
  const state = ensureState(ctx);
  /** @type {Record<string, unknown>} */
  const mem0 = { api_url: url };
  const envFile = (process.env.MEM0_ENV_FILE || state.tomlEnvFile || "").trim();
  if (envFile) mem0.env_file = envFile;
  return { memory: { mem0 } };
}
