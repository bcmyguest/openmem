/**
 * Hindsight's slice of ~/.config/personal-memory/config.toml: [stack] ports and the
 * [model] table. The meta wizard owns [memory], [stack].project, [wizard] and [tasks].
 */

/**
 * Flat Hindsight defaults from a merged TOML config.
 * @param {Record<string, unknown>} cfg
 */
export function defaultsFromConfig(cfg) {
  const stack = /** @type {Record<string, unknown>} */ (cfg.stack || {});
  const model = /** @type {Record<string, unknown>} */ (cfg.model || {});
  const lemond = /** @type {Record<string, unknown>} */ (model.lemond || {});
  const ollama = /** @type {Record<string, unknown>} */ (model.ollama || {});
  return {
    apiPort: stack.api_port != null ? String(stack.api_port) : "",
    cpPort: stack.control_plane_port != null ? String(stack.control_plane_port) : "",
    modelBackend: String(model.backend || ""),
    modelRetain: String(model.retain || ""),
    modelReflect: String(model.reflect || ""),
    modelApiBase: String(model.api_base || ""),
    lemondHost: String(lemond.host || ""),
    ollamaHost: String(ollama.host || ""),
  };
}

/**
 * Apply config defaults into process.env when env/CLI did not set them.
 * @param {Record<string, unknown>} cfg
 */
export function applyConfigEnv(cfg) {
  const d = defaultsFromConfig(cfg);
  if (d.apiPort && !process.env.HINDSIGHT_PORT) process.env.HINDSIGHT_PORT = d.apiPort;
  if (d.cpPort && !process.env.HINDSIGHT_CP_PORT) process.env.HINDSIGHT_CP_PORT = d.cpPort;
  if (d.modelBackend && !process.env.PM_BACKEND) process.env.PM_BACKEND = d.modelBackend;
  if (d.modelRetain && !process.env.PM_DEFAULT_MODEL) {
    process.env.PM_DEFAULT_MODEL = d.modelRetain;
  }
  if (d.modelReflect && !process.env.PM_REFLECT_MODEL) {
    process.env.PM_REFLECT_MODEL = d.modelReflect;
  }
  if (d.modelApiBase && !process.env.MEMORY_API_BASE) {
    process.env.MEMORY_API_BASE = d.modelApiBase;
  }
  if (d.lemondHost && !process.env.LEMOND_BASE) process.env.LEMOND_BASE = d.lemondHost;
}

/**
 * Tables merged into config.toml when the wizard saves it.
 * @param {Record<string, any>} ctx
 * @returns {Record<string, Record<string, unknown>>}
 */
export function configToml(ctx) {
  const model = {
    backend: ctx.backend,
    retain: ctx.model,
    reflect: ctx.reflectModel || "",
    api_base: ctx.apiBase || "",
  };
  if (ctx.backend === "lemond" || ctx.lemondBase) {
    model.lemond = { host: ctx.lemondBase };
  }
  if (ctx.backend === "ollama" || ctx.ollamaBase) {
    model.ollama = { host: ctx.ollamaBase };
  }
  return {
    stack: {
      api_port: Number(ctx.portApi || 8888),
      control_plane_port: Number(ctx.portCp || 9999),
    },
    model,
  };
}
