/**
 * Step "LLM key": Cognee needs an LLM to cognify (build the graph). The wizard writes the
 * answers into the operator env file (cognee.env, mode 600, outside the repo), which the
 * cognee compose service loads. Values are never printed, logged or stored anywhere else;
 * only the path and the key NAMES are reported.
 *
 * Answers come from the environment, so a run is scriptable (also for local models):
 *   PM_COGNEE_LLM_API_KEY     the key (under --yes, plain LLM_API_KEY is read too)
 *   PM_COGNEE_<NAME>          LLM_PROVIDER, LLM_MODEL, LLM_ENDPOINT, EMBEDDING_PROVIDER,
 *                             EMBEDDING_MODEL, EMBEDDING_ENDPOINT, EMBEDDING_API_KEY,
 *                             EMBEDDING_DIMENSIONS
 */
import fs from "node:fs";
import { readEnvFile, mergeEnvText, tooOpen, writePrivateFile } from "./env-file.mjs";
import { configToml } from "./config.mjs";
import { currentPort, ensureState } from "./state.mjs";

/** @typedef {import("../../../wizard/lib/provider-wizard/helpers.mjs").ProviderWizardHelpers} Helpers */

export const KEY_NAME = "LLM_API_KEY";

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
];

/** PM_COGNEE_* variables that carry a secret; removed from the process environment once read. */
const SECRET_ANSWERS = ["PM_COGNEE_LLM_API_KEY", "PM_COGNEE_EMBEDDING_API_KEY"];

/**
 * Answers present in the environment, by env-file key. Secret answers are removed from
 * process.env after they are read, so child processes (docker, curl, scripts/setup.mjs)
 * never inherit them.
 * @param {Record<string, any>} ctx
 * @returns {Record<string, string>}
 */
export function answersFromEnv(ctx) {
  /** @type {Record<string, string>} */
  const answers = {};
  const nonInteractive = ctx.yes || ctx.skipBackendStep || ctx.dry;
  const key = process.env.PM_COGNEE_LLM_API_KEY || (nonInteractive ? process.env[KEY_NAME] : "");
  if (key?.trim()) answers[KEY_NAME] = key.trim();
  for (const name of PASSTHROUGH) {
    const value = process.env[`PM_COGNEE_${name}`];
    if (value?.trim()) answers[name] = value.trim();
  }
  for (const name of SECRET_ANSWERS) delete process.env[name];
  return answers;
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
  if (!answers[KEY_NAME] && !hasStored && !ctx.yes && !ctx.skipBackendStep && !ctx.dry) {
    const typed = await h.ask(
      ctx,
      "Cognee LLM_API_KEY (this prompt echoes what you type; press Enter to skip)",
      "",
    );
    if (typed.trim()) answers[KEY_NAME] = typed.trim();
  }

  const changes = Object.fromEntries(
    Object.entries(answers).filter(([k, v]) => existing.values.get(k) !== v),
  );
  const names = Object.keys(changes);
  const wouldHaveKey = Boolean(answers[KEY_NAME]) || hasStored;

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

  if (!wouldHaveKey) h.warn(COGNIFY_WARNING);
  h.info(
    "Cognee runs in single-user mode (no authentication) on a loopback port. To enable auth by hand: " +
      "set REQUIRE_AUTHENTICATION=true in cognee.env and COGNEE_API_KEY in cognee-indexer.env " +
      "(see providers/cognee/compose.yaml).",
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
