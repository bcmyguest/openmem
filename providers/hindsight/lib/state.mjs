import path from "node:path";

/** Models the shipped LiteLLM routes (config/litellm.<backend>.yaml) use for retain/consolidate. */
export const LEMOND_DEFAULT_MODEL = "Gemma-4-E2B-it-GGUF";
export const OLLAMA_DEFAULT_MODEL = "gemma4:e2b";

/** LiteLLM api_base when Ollama runs on the host (default). */
export const OLLAMA_HOST_API_BASE = "http://host.docker.internal:11434";
/** LiteLLM api_base when Ollama is the compose `ollama` service. */
export const OLLAMA_COMPOSE_API_BASE = "http://ollama:11434";

export const BACKENDS = ["lemond", "ollama", "custom"];

/**
 * Fill the Hindsight fields of the wizard context. Idempotent: a field that is already
 * set (machine.env, a test) is kept.
 * @param {Record<string, any>} ctx
 */
export function ensureState(ctx) {
  const hs = ctx.hsDir || path.join(ctx.home || "", ".config/hindsight");
  const defaults = {
    envFile: path.join(hs, "hindsight.env"),
    litellmEnv: path.join(hs, "litellm.env"),
    litellmOverride: path.join(hs, "litellm.yaml"),
    agentJson: path.join(ctx.home || "", ".hindsight/coding-agent.json"),
    lemondBase: "http://127.0.0.1:13305",
    ollamaBase: "http://127.0.0.1:11434",
    lemondDefaultModel: LEMOND_DEFAULT_MODEL,
    ollamaDefaultModel: OLLAMA_DEFAULT_MODEL,
    customDefaultBase: "http://host.docker.internal:8080/v1",
    backend: "",
    model: "",
    reflectModel: "",
    apiBase: "",
    lemondJson: null,
    lemondNames: [],
    ollamaJson: null,
    ollamaNames: [],
    /** True when Ollama runs as the compose profile `ollama` (no host install). */
    ollamaInCompose: false,
    portApi: "",
    portCp: "",
    hindsightUrl: "",
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (ctx[key] === undefined) ctx[key] = value;
  }
  return ctx;
}

/**
 * @param {Record<string, any>} ctx
 * @param {import("../../../wizard/lib/provider-wizard/helpers.mjs").ProviderWizardHelpers} h
 * @param {string} key wizard.conf key
 */
export function confGet(ctx, h, key) {
  return h.envValue(ctx.wizardConf, key);
}

/**
 * The stored value for `key`, but only when wizard.conf was written for the same backend.
 */
export function storedOr(ctx, h, backend, key, fallback) {
  if (confGet(ctx, h, "MEMORY_BACKEND") !== backend) return fallback;
  return confGet(ctx, h, key) || fallback;
}

/** PM_BACKEND, then the saved MEMORY_BACKEND, then lemond. */
export function backendDefault(ctx, h) {
  const pm = process.env.PM_BACKEND;
  if (BACKENDS.includes(pm)) return pm;
  const saved = confGet(ctx, h, "MEMORY_BACKEND");
  if (BACKENDS.includes(saved)) return saved;
  return "lemond";
}
