/**
 * Cognee's slice of ~/.config/personal-memory/config.toml: the `[memory.cognee]` table
 * (`port`, `env_file`, `indexer_env_file`). It never holds a secret.
 */
import {
  DEFAULT_ENV_FILE,
  DEFAULT_INDEXER_ENV_FILE,
  currentPort,
  ensureState,
  resolveFile,
  tildePath,
} from "./state.mjs";

/** @typedef {import("../../../wizard/lib/provider-wizard/helpers.mjs").ProviderWizardHelpers} Helpers */

/**
 * @param {unknown} value
 * @returns {string} the port as a string, or "" when unset
 */
function portText(value) {
  if (value === undefined || value === null || value === "") return "";
  return String(value);
}

/**
 * The `[memory.cognee]` table from a merged TOML config.
 * @param {Record<string, unknown>} cfg
 * @returns {{ port: string, envFile: string, indexerEnvFile: string }}
 */
export function defaultsFromConfig(cfg) {
  const memory = /** @type {Record<string, any>} */ (cfg.memory || {});
  const table = /** @type {Record<string, unknown>} */ (
    memory.cognee && typeof memory.cognee === "object" ? memory.cognee : {}
  );
  return {
    port: portText(table.port),
    envFile: String(table.env_file || ""),
    indexerEnvFile: String(table.indexer_env_file || ""),
  };
}

/**
 * Map `[memory.cognee]` into the wizard context and, where the table is the only source,
 * into the environment compose and the stack setup script read (COGNEE_PORT,
 * COGNEE_ENV_FILE). The environment and the CLI keep precedence.
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export function applyConfig(ctx, h) {
  ensureState(ctx);
  const d = defaultsFromConfig(ctx.pmMerged || {});
  if (d.port) {
    if (!/^\d+$/.test(d.port) || Number(d.port) < 1 || Number(d.port) > 65535) {
      h.die(`[memory.cognee] port must be a number from 1 to 65535 (got: ${d.port})`);
    }
    ctx.cognee.port = d.port;
    if (!process.env.COGNEE_PORT) process.env.COGNEE_PORT = d.port;
  }
  const defaults = {
    COGNEE_ENV_FILE: DEFAULT_ENV_FILE,
    COGNEE_INDEXER_ENV_FILE: DEFAULT_INDEXER_ENV_FILE,
  };
  for (const [setting, name, field] of /** @type {const} */ ([
    [d.envFile, "COGNEE_ENV_FILE", "configEnvFile"],
    [d.indexerEnvFile, "COGNEE_INDEXER_ENV_FILE", "configIndexerEnvFile"],
  ])) {
    if (process.env[name]?.startsWith("~")) process.env[name] = resolveFile(process.env[name], ctx);
    if (setting) {
      ctx.cognee[field] = setting;
      // Compose reads the path from the environment (or the stack .env, which the stack
      // setup script fills from this export), so a TOML value must be a real absolute path.
      // The shipped default location needs no export (and no .env line).
      const file = resolveFile(setting, ctx);
      if (!process.env[name] && file !== resolveFile(defaults[name], ctx)) process.env[name] = file;
    }
  }
  ensureState(ctx);
}

/**
 * Tables merged into config.toml when the wizard saves it. `memory` replaces the meta
 * wizard's own `[memory]` table, so it carries `provider` too.
 * @param {Record<string, any>} ctx
 * @returns {Record<string, Record<string, unknown>>}
 */
export function configToml(ctx) {
  ensureState(ctx);
  return {
    memory: {
      provider: "cognee",
      cognee: {
        port: Number(currentPort(ctx)),
        env_file: tildePath(ctx.cognee.envFile, ctx.home) || DEFAULT_ENV_FILE,
        indexer_env_file: tildePath(ctx.cognee.indexerEnvFile, ctx.home) || DEFAULT_INDEXER_ENV_FILE,
      },
    },
  };
}
