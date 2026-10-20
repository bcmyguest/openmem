/**
 * Step "LLM key": Cognee needs an LLM to cognify (build the graph). The wizard writes the
 * answers into the operator env file (cognee.env, mode 600, outside the repo), which the
 * cognee compose service loads. Values are never printed, logged or stored anywhere else;
 * only the path and the key NAMES are reported.
 *
 * Answers come from the environment, so a run is scriptable (also for local models):
 *   PM_COGNEE_LLM_API_KEY     the key (under --yes or --dry-run, plain LLM_API_KEY is read too)
 *   PM_COGNEE_<NAME>          LLM_PROVIDER, LLM_MODEL, LLM_ENDPOINT, EMBEDDING_PROVIDER,
 *                             EMBEDDING_MODEL, EMBEDDING_ENDPOINT, EMBEDDING_API_KEY,
 *                             EMBEDDING_DIMENSIONS, HUGGINGFACE_TOKENIZER
 *
 * When LLM_PROVIDER=ollama, missing local settings are filled in (LLM_API_KEY=ollama,
 * bare Ollama endpoint, matching ollama embeddings) so cognify works without a cloud key.
 */
import fs from "node:fs";
import { readEnvFile, mergeEnvText, tooOpen, writePrivateFile } from "./env-file.mjs";
import { configToml } from "./config.mjs";
import { currentPort, ensureState } from "./state.mjs";

/** @typedef {import("../../../wizard/lib/provider-wizard/helpers.mjs").ProviderWizardHelpers} Helpers */

export const KEY_NAME = "LLM_API_KEY";

/** Value Cognee accepts as LLM_API_KEY when talking to local Ollama (not a cloud secret). */
export const OLLAMA_API_KEY = "ollama";

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
 * Fill Ollama local defaults when LLM_PROVIDER is ollama and the operator left a field unset.
 * Does not overwrite an explicit answer. LLM_API_KEY becomes "ollama" when missing
 * (Cognee still requires the variable for its Ollama client).
 * @param {Record<string, string>} answers
 * @returns {Record<string, string>}
 */
export function applyOllamaPreset(answers, env = process.env) {
  const provider = (answers.LLM_PROVIDER || "").trim().toLowerCase();
  if (provider !== "ollama") return answers;
  /** @type {Record<string, string>} */
  const out = { ...answers };
  for (const [name, value] of Object.entries(ollamaDefaultsForEnv(env))) {
    if (!out[name]?.trim()) out[name] = value;
  }
  return out;
}

/**
 * Answers for the env file, by key: the secrets captured in `init` plus the non-secret
 * PM_COGNEE_<NAME> pass-through variables, with the Ollama local block filled in when needed.
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
  return applyOllamaPreset(answers);
}

/**
 * Whether the merged env values look cognify-ready (graph build can run).
 * @param {Map<string, string> | Record<string, string>} values
 */
export function isCognifyReady(values) {
  const get = (/** @type {string} */ k) =>
    values instanceof Map ? values.get(k) || "" : values[k] || "";
  const key = get("LLM_API_KEY").trim();
  if (!key) return false;
  const llm = get("LLM_PROVIDER").trim().toLowerCase() || "openai";
  const emb = get("EMBEDDING_PROVIDER").trim().toLowerCase() || "openai";
  if (llm === "ollama") {
    return emb === "ollama" && Boolean(get("EMBEDDING_ENDPOINT").trim() || get("EMBEDDING_MODEL").trim());
  }
  return true;
}

/**
 * Warn when LLM and embedding providers disagree (Cognee rejects that combination).
 * @param {Map<string, string> | Record<string, string>} values
 * @returns {string | ""}
 */
export function providerMismatchWarning(values) {
  const get = (/** @type {string} */ k) =>
    values instanceof Map ? values.get(k) || "" : values[k] || "";
  const llm = get("LLM_PROVIDER").trim().toLowerCase();
  const emb = get("EMBEDDING_PROVIDER").trim().toLowerCase();
  if (!llm || !emb) return "";
  if (llm === emb) return "";
  return `LLM_PROVIDER=${llm} but EMBEDDING_PROVIDER=${emb}: Cognee requires matching providers (cognify will fail)`;
}

const COGNIFY_WARNING =
  "no LLM_API_KEY: documents will be stored but not searchable until LLM_API_KEY works (cognify needs it)";

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
  const answers = answersFromEnv(ctx);
  for (const [name, value] of Object.entries(answers)) {
    if (/[\r\n\0]/.test(value)) h.die(`the answer for ${name} must be a single line`);
  }

  const hasStored = Boolean(existing.values.get(KEY_NAME));
  // No helpers.ask for the key: it echoes what is typed. Clack uses a masked password prompt;
  // otherwise the operator puts LLM_API_KEY in cognee.env by hand (same as mem0).
  if (!answers[KEY_NAME] && !hasStored && !ctx.yes && !ctx.skipBackendStep && !ctx.dry) {
    h.info(
      `no LLM_API_KEY given. Cognee needs one to cognify: put LLM_API_KEY=<key> in ${file} (mode 600), ` +
        "or rerun the setup UI (hidden prompt), or under --yes set PM_COGNEE_LLM_API_KEY " +
        "(or LLM_API_KEY). For local Ollama: PM_COGNEE_LLM_PROVIDER=ollama (writes LLM_API_KEY=ollama and embeddings).",
    );
  }

  const changes = Object.fromEntries(
    Object.entries(answers).filter(([k, v]) => existing.values.get(k) !== v),
  );
  const names = Object.keys(changes);
  /** Effective values after this write (answers overlay existing). */
  const merged = new Map(existing.values);
  for (const [k, v] of Object.entries(answers)) merged.set(k, v);
  const cognifyReady = isCognifyReady(merged);

  if (ctx.dry) {
    if (names.length) {
      h.info(`[dry-run] write ${file} (mode 600, directory 700): set ${names.join(", ")}`);
    } else if (!existing.exists) {
      h.info(`[dry-run] ${file} would not be created (no LLM settings given)`);
    } else h.info(`[dry-run] keep ${file} unchanged`);
  } else if (names.length) {
    writePrivateFile(file, mergeEnvText(existing.text, changes));
    h.ok(`wrote ${file} (mode 600): ${names.join(", ")}`);
  } else if (existing.exists && tooOpen(file)) {
    fs.chmodSync(file, 0o600);
    h.ok(`kept ${file}; tightened its mode to 600`);
  } else if (existing.exists) {
    h.ok(`kept ${file}${hasStored ? ` (${KEY_NAME} is set)` : ""}`);
  }

  const mismatch = providerMismatchWarning(merged);
  if (mismatch) h.warn(mismatch);
  if (!cognifyReady) h.warn(COGNIFY_WARNING);
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
