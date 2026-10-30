/**
 * Optional: route mem0's LLM (and, when the backend has one, its embedder) through the stack
 * LiteLLM, the gateway Hindsight already uses. The wizard writes the LiteLLM route file, keeps
 * provider keys in litellm.env (mode 600), turns on the compose profile "litellm" (published on
 * 127.0.0.1 only by providers/mem0/compose.yaml) and prints the mem0 config blocks. It never
 * edits the operator's mem0 server config.
 *
 * mem0 side (verified against mem0 main @ 26cdefb): the self-hosted REST server bundles only
 * the openai, anthropic and gemini LLM providers and the openai and gemini embedders
 * (server/main.py BUNDLED_*_PROVIDERS), so the snippet uses provider "openai" with
 * openai_base_url pointing at LiteLLM, not provider "litellm". See docs/mem0.md.
 */
import fs from "node:fs";
import path from "node:path";
import { setLitellmEnvValue } from "../../../wizard/lib/litellm-env.mjs";
import {
  bridgeReport,
  containerApiBase,
  dockerBridgeIp,
  existingMeridianKey,
  MERIDIAN_DEFAULT_BASE,
  MERIDIAN_GUIDE,
  MERIDIAN_NO_KEY,
  MERIDIAN_RETAIN_DEFAULT,
  MERIDIAN_TERMS_URL,
  normalizeMeridianBase,
  probeMeridian,
} from "../../hindsight/lib/meridian.mjs";

/** @typedef {import("../../../wizard/lib/provider-wizard/helpers.mjs").ProviderWizardHelpers} Helpers */

/** LiteLLM model_name aliases mem0 asks for (Hindsight uses memory-retain / reflect / consolidate). */
export const LLM_ALIAS = "memory-llm";
export const EMBED_ALIAS = "memory-embed";
export const DEFAULT_PORT = 4000;
export const BACKENDS = ["ollama", "custom", "anthropic", "meridian"];
/** Backends with an embedding model LiteLLM can serve. Claude (API or Meridian) has none. */
export const EMBED_BACKENDS = ["ollama", "custom"];

const OLLAMA_API_BASE = "http://host.docker.internal:11434";
const CUSTOM_API_BASE = "http://host.docker.internal:8080/v1";
const OLLAMA_DEFAULT_MODEL = "gemma4:e2b";
const OLLAMA_EMBED_DEFAULT = "nomic-embed-text";
/** Known output sizes, for vector_store.config.embedding_model_dims in the snippet. */
const EMBED_DIMS = { "nomic-embed-text": 768, "text-embedding-3-small": 1536, "text-embedding-3-large": 3072 };

/** wizard.conf keys this option owns. */
export const CONF_KEYS = [
  "MEM0_LITELLM",
  "MEM0_LITELLM_BACKEND",
  "MEM0_LITELLM_MODEL",
  "MEM0_LITELLM_API_BASE",
  "MEM0_LITELLM_EMBED_MODEL",
  "MEM0_LITELLM_PORT",
];

/** The setup UI's masked ANTHROPIC_API_KEY answer, taken out of process.env by captureAnthropicKey. */
let capturedAnthropicKey = "";

/**
 * Move PM_ANTHROPIC_API_KEY (the setup UI handoff) out of process.env so no child process
 * (docker, curl) inherits it. Called from the init hook and again before the key is written.
 */
export function captureAnthropicKey() {
  const v = process.env.PM_ANTHROPIC_API_KEY;
  if (v) capturedAnthropicKey = v.trim();
  delete process.env.PM_ANTHROPIC_API_KEY;
}

/** @param {string} home */
export function routesFile(home) {
  return path.join(home || "", ".config/personal-memory/mem0-litellm.yaml");
}

/** litellm.env: LITELLM_ENV_FILE, else Hindsight's default (one master key for the stack LiteLLM). */
export function litellmEnvFile(home) {
  return process.env.LITELLM_ENV_FILE || path.join(home || "", ".config/hindsight/litellm.env");
}

/** @param {string} value */
export function portProblem(value) {
  if (!/^\d+$/.test(String(value))) return "MEM0_LITELLM_PORT must be a port number";
  const n = Number(value);
  if (n < 1 || n > 65535) return "MEM0_LITELLM_PORT must be between 1 and 65535";
  return "";
}

/** A value written into the YAML route file: no spaces, quotes or YAML syntax. */
function modelProblem(label, value) {
  if (!value) return `${label} is empty`;
  if (!/^[A-Za-z0-9._:/@+-]+$/.test(value)) return `${label} has characters a model id cannot have: ${value}`;
  return "";
}

/** @param {string} value */
function apiBaseProblem(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "the API base must be http(s)";
    if (u.username || u.password || u.search || u.hash) return "the API base must not hold credentials, a query or a fragment";
  } catch {
    return `the API base is not a URL: ${value}`;
  }
  return "";
}

/**
 * Validate a choice. Returns the first problem or "".
 * @param {{ backend: string, model: string, apiBase: string, embedModel: string, port: string|number }} c
 */
export function choiceProblem(c) {
  if (!BACKENDS.includes(c.backend)) return `MEM0_LITELLM_BACKEND must be one of ${BACKENDS.join(", ")} (got: ${c.backend})`;
  const m = modelProblem("the model", c.model);
  if (m) return m;
  if (c.backend !== "anthropic") {
    const a = apiBaseProblem(c.apiBase);
    if (a) return a;
  }
  if (c.embedModel) {
    if (!EMBED_BACKENDS.includes(c.backend)) return `the ${c.backend} backend has no embedding model; keep mem0's own embedder`;
    const e = modelProblem("the embedding model", c.embedModel);
    if (e) return e;
  }
  return portProblem(c.port);
}

/** One route entry. */
function route(alias, model, extra) {
  return `  - model_name: ${alias}\n    litellm_params:\n      model: ${model}\n${extra}`;
}

/**
 * The LiteLLM route file for mem0. Keys are referenced as os.environ/<NAME> and live in litellm.env.
 * @param {{ backend: string, model: string, apiBase: string, embedModel: string }} c
 * @returns {string}
 */
export function renderRoutes(c) {
  const head =
    "# Written by ./setup (mem0, \"route mem0's LLM through the stack LiteLLM\"). Rerun ./setup to change it.\n" +
    `# mem0 calls ${LLM_ALIAS}${c.embedModel ? ` and ${EMBED_ALIAS}` : ""}; keys live in litellm.env, never here.\n`;
  let out = `${head}model_list:\n`;
  switch (c.backend) {
    case "ollama":
      out += route(LLM_ALIAS, `ollama_chat/${c.model}`, `      api_base: ${c.apiBase}\n      max_tokens: 4096\n      timeout: 300\n`);
      if (c.embedModel) out += route(EMBED_ALIAS, `ollama/${c.embedModel}`, `      api_base: ${c.apiBase}\n`);
      break;
    case "custom":
      // Same key variable as Hindsight's custom route; set it in litellm.env when the server needs one.
      out += route(
        LLM_ALIAS,
        `openai/${c.model}`,
        `      api_base: ${c.apiBase}\n      api_key: os.environ/LEMOND_API_KEY\n      max_tokens: 4096\n      timeout: 300\n`,
      );
      if (c.embedModel) {
        out += route(EMBED_ALIAS, `openai/${c.embedModel}`, `      api_base: ${c.apiBase}\n      api_key: os.environ/LEMOND_API_KEY\n`);
      }
      break;
    case "anthropic":
      out += route(LLM_ALIAS, `anthropic/${c.model}`, "      api_key: os.environ/ANTHROPIC_API_KEY\n      max_tokens: 4096\n      timeout: 300\n");
      break;
    case "meridian":
      out += route(
        LLM_ALIAS,
        `anthropic/${c.model}`,
        `      api_base: ${c.apiBase}\n      api_key: os.environ/MERIDIAN_API_KEY\n      max_tokens: 4096\n      timeout: 300\n` +
          '      additional_drop_params: ["reasoning_effort"]\n',
      );
      break;
    default:
      throw new Error(`unknown backend ${c.backend}`);
  }
  return `${out}\ngeneral_settings:\n  master_key: os.environ/LITELLM_MASTER_KEY\n`;
}

/**
 * The mem0 config blocks that point mem0 at the stack LiteLLM. The key is a placeholder: the
 * operator copies LITELLM_MASTER_KEY from litellm.env.
 * @param {{ port: string|number, embedModel: string }} c
 * @returns {Record<string, any>}
 */
export function mem0Config(c) {
  const base = `http://127.0.0.1:${c.port}/v1`;
  const key = "<LITELLM_MASTER_KEY from litellm.env>";
  /** @type {Record<string, any>} */
  const cfg = { llm: { provider: "openai", config: { model: LLM_ALIAS, openai_base_url: base, api_key: key } } };
  if (c.embedModel) {
    cfg.embedder = { provider: "openai", config: { model: EMBED_ALIAS, openai_base_url: base, api_key: key } };
    const dims = EMBED_DIMS[c.embedModel.replace(/:latest$/, "")];
    cfg.vector_store = { config: { embedding_model_dims: dims || "<your embedding model's output size>" } };
  }
  return cfg;
}

/**
 * Lines that print the snippet and how to apply it.
 * @param {{ port: string|number, embedModel: string, backend: string }} c
 * @param {string} envFile litellm.env
 * @returns {string[]}
 */
export function snippetLines(c, envFile) {
  const json = JSON.stringify(mem0Config(c), null, 2);
  const lines = [
    "mem0 config for the stack LiteLLM (this wizard does not edit your mem0 server config):",
    ...json.split("\n").map((l) => `    ${l}`),
    `  api_key: the LITELLM_MASTER_KEY value in ${envFile} (not printed here).`,
    "  Self-hosted REST server: POST this JSON to /configure with an admin key (it deep-merges and persists).",
    "  Python SDK: merge the blocks into the dict you pass to Memory.from_config.",
    `  The URL is loopback: it works for a mem0 server running on this host, not one inside another container.`,
  ];
  if (c.embedModel) {
    lines.push(
      "  A different embedder changes the vector size: point vector_store at a new collection (or re-add the memories).",
    );
  } else {
    lines.push(`  Embeddings stay on mem0's own embedder: the ${c.backend} backend has no embedding model here.`);
  }
  lines.push("  mem0's openai LLM ignores openai_base_url when OPENROUTER_API_KEY is set in the server's environment.");
  return lines;
}

/**
 * The option's current answers: environment (--yes, setup UI handoff), then wizard.conf, then defaults.
 * Model, API base and embedding model come from wizard.conf only when it was saved for the same backend.
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 * @param {string} [backendOverride] the backend picked interactively
 */
export function storedChoice(ctx, h, backendOverride = "") {
  const conf = (k) => (ctx.wizardConf ? h.envValue(ctx.wizardConf, k) : "");
  const stack = ctx.repoRoot ? path.join(ctx.repoRoot, ".env") : "";
  const pick = (k, fallback = "") => String(process.env[k] ?? "").trim() || conf(k) || fallback;
  const enabled = (process.env.MEM0_LITELLM ?? conf("MEM0_LITELLM")) === "1";
  const backend = backendOverride || pick("MEM0_LITELLM_BACKEND", "ollama");
  const sameBackend = conf("MEM0_LITELLM_BACKEND") === backend;
  const fromConf = (k) => String(process.env[k] ?? "").trim() || (sameBackend ? conf(k) : "");
  let apiBase = fromConf("MEM0_LITELLM_API_BASE");
  let model = fromConf("MEM0_LITELLM_MODEL");
  let embed = process.env.MEM0_LITELLM_EMBED_MODEL ?? (sameBackend ? conf("MEM0_LITELLM_EMBED_MODEL") : undefined);
  if (backend === "ollama") {
    apiBase ||= OLLAMA_API_BASE;
    model ||= OLLAMA_DEFAULT_MODEL;
    if (embed === undefined) embed = OLLAMA_EMBED_DEFAULT;
  } else if (backend === "custom") {
    apiBase ||= CUSTOM_API_BASE;
  } else if (backend === "anthropic") {
    apiBase = "";
    model ||= MERIDIAN_RETAIN_DEFAULT;
  } else if (backend === "meridian") {
    model ||= MERIDIAN_RETAIN_DEFAULT;
  }
  embed = String(embed ?? "").trim();
  if (embed === "none") embed = "";
  const port =
    String(process.env.MEM0_LITELLM_PORT ?? "").trim() ||
    (stack && h.envValue(stack, "MEM0_LITELLM_PORT")) ||
    conf("MEM0_LITELLM_PORT") ||
    String(DEFAULT_PORT);
  return { enabled, backend, model, apiBase, embedModel: embed, port };
}

/**
 * Meridian: probe it the way Hindsight's wizard does, keep MERIDIAN_API_KEY in litellm.env.
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 * @param {Record<string, any>} c
 * @param {boolean} interactive
 */
async function chooseMeridian(ctx, h, c, interactive) {
  h.warn(`Claude subscription use through Meridian is governed by Anthropic's Consumer Terms: ${MERIDIAN_TERMS_URL}`);
  h.info(`The wizard does not install or start Meridian; see ${MERIDIAN_GUIDE}.`);
  const mctx = {
    meridianEnvFile: path.join(ctx.home || "", ".config/meridian/meridian.env"),
    litellmEnv: litellmEnvFile(ctx.home),
    dockerBridgeIp: dockerBridgeIp(),
  };
  let hostBase = process.env.MERIDIAN_BASE || MERIDIAN_DEFAULT_BASE;
  if (interactive) hostBase = await h.ask(ctx, "Meridian URL from this host", hostBase);
  hostBase = normalizeMeridianBase(hostBase);
  try {
    // A saved or MEM0_LITELLM_API_BASE value wins under --yes; a typed or MERIDIAN_BASE URL replaces it.
    if (interactive || process.env.MERIDIAN_BASE || !c.apiBase) c.apiBase = containerApiBase(hostBase);
  } catch {
    h.problem(ctx, `not a URL: ${hostBase}`);
    return false;
  }
  const existing = existingMeridianKey(mctx, h);
  c.meridianKey = existing.key;
  if (ctx.dry) {
    h.info(`[dry-run] probe Meridian at ${hostBase}`);
    return true;
  }
  const probe = await probeMeridian(hostBase, existing.key, mctx.dockerBridgeIp);
  if (!probe.answered) h.warn(`Meridian is not answering on ${hostBase}; start it first (${MERIDIAN_GUIDE}).`);
  else if (probe.ids.length && !probe.ids.includes(c.model)) h.warn(`${c.model} is not listed by Meridian's /v1/models`);
  const bridge = bridgeReport({ ...mctx, meridianBase: hostBase, apiBase: c.apiBase }, h.envValue, probe);
  if (bridge) h[bridge.level](bridge.text);
  return true;
}

/**
 * Write litellm.env keys the backend needs (never printed): ANTHROPIC_API_KEY from the
 * environment, MERIDIAN_API_KEY from the environment or Meridian's env file.
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 * @param {Record<string, any>} c
 */
function writeBackendKeys(ctx, h, c) {
  const envFile = litellmEnvFile(ctx.home);
  if (c.backend === "anthropic") {
    captureAnthropicKey();
    const key = String(capturedAnthropicKey || process.env.ANTHROPIC_API_KEY || "").trim();
    if (ctx.dry) {
      h.info(`[dry-run] ${key ? `set ANTHROPIC_API_KEY in ${envFile} (mode 600; value not printed)` : `check ANTHROPIC_API_KEY in ${envFile}`}`);
      return;
    }
    if (key) {
      const r = setLitellmEnvValue(envFile, "ANTHROPIC_API_KEY", key);
      h.ok(`${r === "unchanged" ? "kept" : "set"} ANTHROPIC_API_KEY in ${envFile} (mode 600)`);
    } else if (!h.envValue(envFile, "ANTHROPIC_API_KEY")) {
      h.warn(`put ANTHROPIC_API_KEY=... in ${envFile} (mode 600), or rerun with ANTHROPIC_API_KEY in the environment`);
    } else h.ok(`kept ANTHROPIC_API_KEY in ${envFile}`);
  }
  if (c.backend === "meridian") {
    if (ctx.dry) {
      h.info(`[dry-run] set MERIDIAN_API_KEY in ${envFile} (mode 600; value not printed)`);
      return;
    }
    const value = c.meridianKey || h.envValue(envFile, "MERIDIAN_API_KEY") || MERIDIAN_NO_KEY;
    setLitellmEnvValue(envFile, "MERIDIAN_API_KEY", value);
    h.ok(`set MERIDIAN_API_KEY in ${envFile} (mode 600)`);
    if (value === MERIDIAN_NO_KEY) h.warn("No MERIDIAN_API_KEY: anyone who can reach Meridian can use your subscription.");
  }
}

/**
 * Write the route file (mode 644; it holds no secrets). Keeps a .bak of a different file.
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 * @param {string} content
 */
function writeRoutes(ctx, h, content) {
  const file = routesFile(ctx.home);
  if (ctx.dry) {
    h.info(`[dry-run] write ${file}: ${LLM_ALIAS}${content.includes(EMBED_ALIAS) ? ` and ${EMBED_ALIAS}` : ""}`);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, "utf8") === content) {
      h.ok(`${file} already has these routes`);
      return;
    }
    fs.copyFileSync(file, `${file}.bak`);
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o644 });
  fs.renameSync(tmp, file);
  h.ok(`wrote ${file}`);
}

/**
 * The option itself, run after the URL and key step. Fills ctx.mem0.litellm (null when off).
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 * @returns {Promise<Record<string, string>|null>} wizard.conf keys to save, or null when off
 */
export async function configureLitellm(ctx, h) {
  const state = (ctx.mem0 ||= {});
  const interactive = !ctx.yes && !ctx.skipBackendStep;
  const c = storedChoice(ctx, h);
  let enabled = c.enabled;
  if (interactive) {
    enabled = await h.confirm(ctx, "Route mem0's LLM through the stack LiteLLM (same gateway as Hindsight)?", c.enabled ? "y" : "n");
  }
  if (!enabled) {
    state.litellm = null;
    if (c.enabled) h.info("stack LiteLLM for mem0: off (the litellm profile is removed on this run)");
    return null;
  }
  h.info("mem0's LLM goes through the stack LiteLLM (compose profile litellm, 127.0.0.1 only).");

  if (interactive) {
    h.info("1) Ollama   2) custom OpenAI-compatible URL   3) Anthropic API key   4) Claude subscription (Meridian)");
    const defNum = String(BACKENDS.indexOf(c.backend) + 1 || 1);
    const pick = await h.ask(ctx, "LiteLLM backend for mem0 (1-4)", defNum);
    const backend = BACKENDS[Number(pick) - 1];
    if (!backend) {
      h.problem(ctx, "choose 1, 2, 3 or 4");
      return null;
    }
    if (backend !== c.backend) Object.assign(c, storedChoice(ctx, h, backend), { enabled: true });
    if (backend === "ollama" || backend === "custom") {
      h.info("The litellm container calls this URL; host services are host.docker.internal.");
      c.apiBase = String(await h.ask(ctx, "Model server base URL (as the container sees it)", c.apiBase)).trim();
    }
    c.model = String(await h.ask(ctx, "Model id for mem0's LLM", c.model)).trim();
    if (EMBED_BACKENDS.includes(backend)) {
      const e = String(await h.ask(ctx, "Embedding model through LiteLLM (none keeps mem0's own embedder)", c.embedModel || "none")).trim();
      c.embedModel = e === "none" ? "" : e;
    }
  }
  if (!EMBED_BACKENDS.includes(c.backend) && c.embedModel) {
    h.info(`the ${c.backend} backend has no embedding model; mem0 keeps its own embedder`);
    c.embedModel = "";
  }
  if (c.backend === "meridian" && !(await chooseMeridian(ctx, h, c, interactive))) return null;

  const issue = choiceProblem(c);
  if (issue) {
    h.problem(ctx, `stack LiteLLM for mem0: ${issue}`);
    return null;
  }
  // Loopback port for the mem0 server: kept when free or held by this project, else the next free one.
  if (ctx.dry) {
    const free = await h.portFree(Number(c.port));
    h.info(`[dry-run] publish LiteLLM on 127.0.0.1:${c.port} (${free ? "free now" : "busy now: a real run offers the next free port"})`);
  } else {
    c.port = String(await h.choosePort(ctx, "LiteLLM (mem0)", Number(c.port), { envVars: ["MEM0_LITELLM_PORT"] }));
  }
  process.env.MEM0_LITELLM_PORT = c.port;

  writeRoutes(ctx, h, renderRoutes(c));
  writeBackendKeys(ctx, h, c);
  state.litellm = { backend: c.backend, model: c.model, apiBase: c.apiBase, embedModel: c.embedModel, port: c.port };
  for (const line of snippetLines(c, litellmEnvFile(ctx.home))) h.info(line);
  return {
    MEM0_LITELLM: "1",
    MEM0_LITELLM_BACKEND: c.backend,
    MEM0_LITELLM_MODEL: c.model,
    MEM0_LITELLM_API_BASE: c.apiBase,
    MEM0_LITELLM_EMBED_MODEL: c.embedModel,
    MEM0_LITELLM_PORT: c.port,
  };
}

/**
 * Environment for scripts/setup.mjs when the option is on.
 * @param {Record<string, any>} ctx
 * @returns {Record<string, string>}
 */
export function stackEnvFor(ctx) {
  const l = ctx.mem0?.litellm;
  // Off: override an exported MEM0_LITELLM=1 the operator declined; otherwise add nothing.
  if (!l) return process.env.MEM0_LITELLM === "1" ? { MEM0_LITELLM: "0" } : {};
  return { MEM0_LITELLM: "1", MEM0_LITELLM_PORT: l.port, MEM0_LITELLM_CONFIG: routesFile(ctx.home) };
}

/**
 * Add or remove the compose profile "litellm" on the wizard's up command.
 * @param {Record<string, any>} ctx
 * @param {boolean} on
 */
export function applyProfile(ctx, on) {
  const extra = (ctx.extraComposeProfiles || []).filter((p) => p !== "litellm");
  if (on) extra.push("litellm");
  ctx.extraComposeProfiles = extra;
}
