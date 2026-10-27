/**
 * Step "LLM / embeddings": Cognee cognify settings go in the operator env file
 * (cognee.env, mode 600, outside the repo). Values are never printed, logged or stored
 * anywhere else; only the path and the key NAMES are reported.
 *
 * Default cognify path (no cloud key): GRAPH_EXTRACTOR=gliner_demo + FastEmbed
 * (BAAI/bge-small-en-v1.5). Alternatives: LLM_PROVIDER=ollama (with ollama or fastembed
 * embeddings), or an OpenAI-compatible LLM_API_KEY.
 *
 * Answers come from the environment, so a run is scriptable:
 *   PM_COGNEE_LLM_API_KEY     the key (under --yes or --dry-run, plain LLM_API_KEY is read too)
 *   PM_COGNEE_<NAME>          LLM_PROVIDER, LLM_MODEL, LLM_ENDPOINT, EMBEDDING_PROVIDER,
 *                             EMBEDDING_MODEL, EMBEDDING_ENDPOINT, EMBEDDING_API_KEY,
 *                             EMBEDDING_DIMENSIONS, HUGGINGFACE_TOKENIZER,
 *                             GRAPH_EXTRACTOR, AUTO_FEEDBACK
 *
 * When LLM_PROVIDER=ollama, missing local settings are filled in (LLM_API_KEY=ollama,
 * bare Ollama endpoint, matching ollama embeddings) so cognify works without a cloud key.
 * When nothing cognify-related is given and the env file is not already cognify-ready,
 * the GLiNER + FastEmbed defaults are written.
 */
import fs from "node:fs";
import { readEnvFile, mergeEnvText, dropEnvKeys, tooOpen, writePrivateFile } from "./env-file.mjs";
import { configToml } from "./config.mjs";
import { currentPort, ensureState } from "./state.mjs";

/** @typedef {import("../../../wizard/lib/provider-wizard/helpers.mjs").ProviderWizardHelpers} Helpers */

export const KEY_NAME = "LLM_API_KEY";

/** Value Cognee accepts as LLM_API_KEY when talking to local Ollama (not a cloud secret). */
export const OLLAMA_API_KEY = "ollama";

/**
 * Default cognify path: local GLiNER2 demo extraction + FastEmbed (CPU, no API key).
 * Requires the cognee image extras (gliner2 + fastembed), which the pinned image ships.
 */
export const GLINER_FASTEMBED_DEFAULTS = {
  GRAPH_EXTRACTOR: "gliner_demo",
  EMBEDDING_PROVIDER: "fastembed",
  EMBEDDING_MODEL: "BAAI/bge-small-en-v1.5",
  EMBEDDING_DIMENSIONS: "384",
  AUTO_FEEDBACK: "false",
};

/** Env keys that are wrong for FastEmbed and should be removed when applying that preset. */
export const FASTEMBED_DROP_KEYS = ["EMBEDDING_ENDPOINT"];

/**
 * Defaults when LLM_PROVIDER=ollama and the operator did not override them.
 * Host Ollama (bridge / all-interfaces) uses host.docker.internal. Compose Ollama published
 * as 127.0.0.1 only cannot be reached that way — use service DNS on a shared network
 * (`PM_COGNEE_OLLAMA_COMPOSE=1` or `MEMORY_OLLAMA_IN_COMPOSE=1` → http://ollama:11434).
 */
export const OLLAMA_DEFAULTS = {
  LLM_API_KEY: OLLAMA_API_KEY,
  LLM_ENDPOINT: "http://host.docker.internal:11434",
  EMBEDDING_PROVIDER: "ollama",
  EMBEDDING_MODEL: "nomic-embed-text:latest",
  EMBEDDING_ENDPOINT: "http://host.docker.internal:11434/api/embed",
  EMBEDDING_DIMENSIONS: "768",
};

/** @returns {Record<string, string>} */
export function ollamaDefaultsForEnv(env = process.env) {
  const compose =
    env.PM_COGNEE_OLLAMA_COMPOSE === "1" || env.MEMORY_OLLAMA_IN_COMPOSE === "1";
  if (!compose) return { ...OLLAMA_DEFAULTS };
  return {
    ...OLLAMA_DEFAULTS,
    LLM_ENDPOINT: "http://ollama:11434",
    EMBEDDING_ENDPOINT: "http://ollama:11434/api/embed",
  };
}

/** Optional keys passed through when set as PM_COGNEE_<NAME>. */
export const PASSTHROUGH = [
  "LLM_PROVIDER",
  "LLM_MODEL",
  "LLM_ENDPOINT",
  "EMBEDDING_PROVIDER",
  "EMBEDDING_MODEL",
  "EMBEDDING_ENDPOINT",
  "EMBEDDING_API_KEY",
  "EMBEDDING_DIMENSIONS",
  "HUGGINGFACE_TOKENIZER",
  "GRAPH_EXTRACTOR",
  "AUTO_FEEDBACK",
];

/** Answers that are secrets: env-file key -> [PM_COGNEE_ variable, plain variable used under --yes]. */
const SECRET_KEYS = /** @type {const} */ ({
  LLM_API_KEY: ["PM_COGNEE_LLM_API_KEY", "LLM_API_KEY"],
  EMBEDDING_API_KEY: ["PM_COGNEE_EMBEDDING_API_KEY", "EMBEDDING_API_KEY"],
});

/**
 * Secret answers taken out of the environment, per wizard context. Module-private on
 * purpose: nothing outside this file can read them, they are never put on `ctx` (which is
 * handed to every hook and helper), and a later `process.env` copy cannot contain them.
 * @type {WeakMap<object, Record<string, string>>}
 */
const captured = new WeakMap();

/**
 * Take the secret answers out of `process.env` before the wizard starts any child process
 * (docker, curl, scripts/setup.mjs inherit the environment). Called from the `init` hook,
 * which runs before the first docker call. PM_COGNEE_* secrets are always taken; plain
 * LLM_API_KEY / EMBEDDING_API_KEY / COGNEE_API_KEY are always scrubbed from the environment
 * (so children never inherit them). Plain LLM/EMBEDDING values are only *consumed* as answers
 * under --yes or --dry-run (Clack / interactive use PM_COGNEE_* or the masked UI). Calling it
 * again keeps what an earlier call captured.
 * @param {Record<string, any>} ctx
 */
export function captureSecrets(ctx) {
  const mine = captured.get(ctx) || {};
  const consumePlain = Boolean(ctx.yes || ctx.dry);
  for (const [key, [pmName, plainName]] of Object.entries(SECRET_KEYS)) {
    const fromPm = process.env[pmName]?.trim();
    delete process.env[pmName];
    const plain = process.env[plainName]?.trim();
    delete process.env[plainName];
    let value = fromPm;
    if (consumePlain) value ||= plain;
    if (value) mine[key] = value;
  }
  // Indexer auth key: scrub always; keep for this run's smoke (file is preferred at read time).
  const cogneeKey = process.env.COGNEE_API_KEY?.trim();
  delete process.env.COGNEE_API_KEY;
  if (cogneeKey) mine.COGNEE_API_KEY = cogneeKey;
  captured.set(ctx, mine);
  return mine;
}

/**
 * COGNEE_API_KEY captured in `init` (already removed from process.env). Prefer the indexer
 * env file when present; this is the fallback for a one-shot env under --yes.
 * @param {Record<string, any>} ctx
 */
export function capturedCogneeApiKey(ctx) {
  return (captured.get(ctx) || {}).COGNEE_API_KEY || "";
}

/**
 * Fill FastEmbed embedding model/dims when EMBEDDING_PROVIDER=fastembed and fields are unset.
 * Does not set GRAPH_EXTRACTOR (LLM extraction can still run with FastEmbed vectors).
 * @param {Record<string, string>} answers
 * @returns {Record<string, string>}
 */
export function applyFastembedEmbeddingDefaults(answers) {
  /** @type {Record<string, string>} */
  const out = { ...answers };
  for (const name of ["EMBEDDING_PROVIDER", "EMBEDDING_MODEL", "EMBEDDING_DIMENSIONS"]) {
    if (!out[name]?.trim()) out[name] = GLINER_FASTEMBED_DEFAULTS[name];
  }
  return out;
}

/**
 * Fill Ollama local defaults when LLM_PROVIDER is ollama and the operator left a field unset.
 * Does not overwrite an explicit answer. LLM_API_KEY becomes "ollama" when missing
 * (Cognee still requires the variable for its Ollama client). Explicit EMBEDDING_PROVIDER=
 * fastembed is kept (Ollama LLM + FastEmbed embeddings is a supported local pair) without
 * forcing GRAPH_EXTRACTOR=gliner_demo.
 * @param {Record<string, string>} answers
 * @returns {Record<string, string>}
 */
export function applyOllamaPreset(answers, env = process.env) {
  const provider = (answers.LLM_PROVIDER || "").trim().toLowerCase();
  if (provider !== "ollama") return answers;
  /** @type {Record<string, string>} */
  const out = { ...answers };
  const emb = (out.EMBEDDING_PROVIDER || "").trim().toLowerCase();
  const defaults = ollamaDefaultsForEnv(env);
  for (const [name, value] of Object.entries(defaults)) {
    if (emb === "fastembed" && name.startsWith("EMBEDDING_")) continue;
    if (!out[name]?.trim()) out[name] = value;
  }
  if (emb === "fastembed") return applyFastembedEmbeddingDefaults(out);
  return out;
}

/**
 * Fill GLiNER + FastEmbed defaults (path B / wizard default). Does not set LLM_API_KEY.
 * @param {Record<string, string>} answers
 * @returns {Record<string, string>}
 */
export function applyGlinerFastembedPreset(answers) {
  /** @type {Record<string, string>} */
  const out = applyFastembedEmbeddingDefaults(answers);
  for (const name of ["GRAPH_EXTRACTOR", "AUTO_FEEDBACK"]) {
    if (!out[name]?.trim()) out[name] = GLINER_FASTEMBED_DEFAULTS[name];
  }
  return out;
}

/**
 * True when `answers` has any cognify-related key (secrets or pass-through).
 * @param {Record<string, string>} answers
 */
function hasCognifyAnswers(answers) {
  return Object.keys(answers).some((k) => k === KEY_NAME || PASSTHROUGH.includes(k) || k in SECRET_KEYS);
}

/**
 * Answers for the env file, by key: the secrets captured in `init` plus the non-secret
 * PM_COGNEE_<NAME> pass-through variables, with the matching local preset filled in.
 * @param {Record<string, any>} ctx
 * @returns {Record<string, string>}
 */
export function answersFromEnv(ctx) {
  /** @type {Record<string, string>} */
  const answers = { ...(captured.get(ctx) || captureSecrets(ctx)) };
  // COGNEE_API_KEY is for smoke / the indexer file, not cognee.env.
  delete answers.COGNEE_API_KEY;
  for (const name of PASSTHROUGH) {
    if (name in SECRET_KEYS) continue;
    const value = process.env[`PM_COGNEE_${name}`];
    if (value?.trim()) answers[name] = value.trim();
  }
  const llm = (answers.LLM_PROVIDER || "").trim().toLowerCase();
  const emb = (answers.EMBEDDING_PROVIDER || "").trim().toLowerCase();
  const extractor = (answers.GRAPH_EXTRACTOR || "").trim().toLowerCase();
  if (llm === "ollama") return applyOllamaPreset(answers);
  if (extractor === "gliner_demo") return applyGlinerFastembedPreset(answers);
  if (emb === "fastembed") return applyFastembedEmbeddingDefaults(answers);
  return answers;
}

/**
 * Read a value from a Map or plain object of env settings.
 * @param {Map<string, string> | Record<string, string>} values
 * @param {string} k
 */
function envGet(values, k) {
  return (values instanceof Map ? values.get(k) || "" : values[k] || "").trim();
}

/**
 * Whether the merged env values look cognify-ready (graph build can run).
 * Ready when: GLiNER + FastEmbed (no LLM key), or a usable LLM key with compatible embeddings.
 * @param {Map<string, string> | Record<string, string>} values
 */
export function isCognifyReady(values) {
  const emb = envGet(values, "EMBEDDING_PROVIDER").toLowerCase();
  const extractor = envGet(values, "GRAPH_EXTRACTOR").toLowerCase();
  const embModel = envGet(values, "EMBEDDING_MODEL");
  if (emb === "fastembed" && embModel) return true;
  if (extractor === "gliner_demo" && (!emb || emb === "fastembed")) return true;

  const key = envGet(values, "LLM_API_KEY");
  if (!key) return false;
  const llm = envGet(values, "LLM_PROVIDER").toLowerCase() || "openai";
  const embOrDefault = emb || "openai";
  if (llm === "ollama") {
    if (embOrDefault === "fastembed") return Boolean(embModel);
    return embOrDefault === "ollama" && Boolean(envGet(values, "EMBEDDING_ENDPOINT") || embModel);
  }
  return true;
}

/**
 * Warn when LLM and embedding providers are a known-bad pair.
 * FastEmbed is allowed with any LLM (including none). Same-provider pairs are fine.
 * @param {Map<string, string> | Record<string, string>} values
 * @returns {string | ""}
 */
export function providerMismatchWarning(values) {
  const llm = envGet(values, "LLM_PROVIDER").toLowerCase();
  const emb = envGet(values, "EMBEDDING_PROVIDER").toLowerCase();
  if (!llm || !emb) return "";
  if (llm === emb) return "";
  if (emb === "fastembed") return "";
  return (
    `LLM_PROVIDER=${llm} but EMBEDDING_PROVIDER=${emb}: ` +
    "Cognee may fall back to OpenAI for the other half — use matching local providers, " +
    "or EMBEDDING_PROVIDER=fastembed"
  );
}

const COGNIFY_WARNING =
  "no cognify-ready config: documents will be stored but not searchable until " +
  "GRAPH_EXTRACTOR=gliner_demo with FastEmbed embeddings, LLM_PROVIDER=ollama, or LLM_API_KEY works";

/**
 * Collect the answers, merge them into the env file, and record the port.
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export async function configureLlm(ctx, h) {
  ensureState(ctx);
  const file = ctx.cognee.envFile;
  const existing = readEnvFile(file);
  if (existing.error) h.die(`cannot read ${file} (${existing.error}); fix its permissions and rerun`);
  let answers = answersFromEnv(ctx);
  // Fresh / incomplete setup with no answers: default to GLiNER + FastEmbed.
  if (!hasCognifyAnswers(answers) && !isCognifyReady(existing.values)) {
    answers = { ...GLINER_FASTEMBED_DEFAULTS };
  }
  for (const [name, value] of Object.entries(answers)) {
    if (/[\r\n\0]/.test(value)) h.die(`the answer for ${name} must be a single line`);
  }

  const hasStored = Boolean(existing.values.get(KEY_NAME));
  const emb = (answers.EMBEDDING_PROVIDER || "").trim().toLowerCase();
  const extractor = (answers.GRAPH_EXTRACTOR || "").trim().toLowerCase();
  const usingFastembed = emb === "fastembed" || extractor === "gliner_demo";
  // No helpers.ask for the key: it echoes what is typed. Clack uses a masked password prompt;
  // otherwise the operator puts LLM_API_KEY in cognee.env by hand (same as mem0).
  if (!answers[KEY_NAME] && !hasStored && !usingFastembed && !ctx.yes && !ctx.skipBackendStep && !ctx.dry) {
    h.info(
      `no LLM_API_KEY given. Cognee cognify defaults to local GLiNER + FastEmbed, or set ` +
        `LLM_API_KEY in ${file} (mode 600), or PM_COGNEE_LLM_PROVIDER=ollama / PM_COGNEE_LLM_API_KEY.`,
    );
  }

  const changes = Object.fromEntries(
    Object.entries(answers).filter(([k, v]) => existing.values.get(k) !== v),
  );
  const names = Object.keys(changes);
  const dropKeys = usingFastembed
    ? FASTEMBED_DROP_KEYS.filter((k) => existing.values.has(k) && !(k in answers))
    : [];
  /** Effective values after this write (answers overlay existing; drops removed). */
  const merged = new Map(existing.values);
  for (const [k, v] of Object.entries(answers)) merged.set(k, v);
  for (const k of dropKeys) merged.delete(k);
  const cognifyReady = isCognifyReady(merged);

  if (ctx.dry) {
    if (names.length || dropKeys.length) {
      const dropNote = dropKeys.length ? `; drop ${dropKeys.join(", ")}` : "";
      h.info(
        `[dry-run] write ${file} (mode 600, directory 700): set ${names.join(", ") || "(no sets)"}${dropNote}`,
      );
    } else if (!existing.exists) {
      h.info(`[dry-run] ${file} would not be created (no LLM settings given)`);
    } else h.info(`[dry-run] keep ${file} unchanged`);
  } else if (names.length || dropKeys.length) {
    let text = mergeEnvText(existing.text, changes);
    if (dropKeys.length) text = dropEnvKeys(text, dropKeys);
    writePrivateFile(file, text);
    const dropNote = dropKeys.length ? `, dropped ${dropKeys.join(", ")}` : "";
    h.ok(`wrote ${file} (mode 600): ${names.join(", ") || "updated"}${dropNote}`);
  } else if (existing.exists && tooOpen(file)) {
    fs.chmodSync(file, 0o600);
    h.ok(`kept ${file}; tightened its mode to 600`);
  } else if (existing.exists) {
    h.ok(`kept ${file}${hasStored ? ` (${KEY_NAME} is set)` : ""}`);
  }

  const mismatch = providerMismatchWarning(merged);
  if (mismatch) h.warn(mismatch);
  if (!cognifyReady) h.warn(COGNIFY_WARNING);
  else if (usingFastembed) {
    h.info(
      "Cognee cognify uses local GLiNER extraction + FastEmbed embeddings " +
        "(first run downloads ~800 MB of models into the container HF cache).",
    );
  }
  h.info(
    "Cognee runs in single-user mode: ENABLE_BACKEND_ACCESS_CONTROL is pinned to false in " +
      "providers/cognee/compose.yaml and overrides the env file, so REQUIRE_AUTHENTICATION alone " +
      "cannot turn auth on. To enable auth, change that compose pin and set REQUIRE_AUTHENTICATION=true " +
      "in cognee.env plus COGNEE_API_KEY in cognee-indexer.env.",
  );

  saveConf(ctx, h);
}

/**
 * Record the non-secret choices in wizard.conf and config.toml.
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
function saveConf(ctx, h) {
  if (ctx.dry) {
    h.info(`[dry-run] record COGNEE_PORT=${currentPort(ctx)} in ${ctx.wizardConf}`);
    return;
  }
  h.saveWizardConf(ctx, { COGNEE_PORT: currentPort(ctx) }, { pmSections: configToml(ctx) });
}
