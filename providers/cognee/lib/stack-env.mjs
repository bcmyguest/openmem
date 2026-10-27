/**
 * Cognee's contribution to scripts/setup.mjs: the COGNEE_PORT entry of the stack .env, the paths of
 * non-default env files (COGNEE_ENV_FILE, COGNEE_INDEXER_ENV_FILE: paths, never contents), an inert
 * LITELLM_CONFIG entry, and the end-of-run notices about the Cognee env file.
 * Runs as a plain Node script step (no wizard context), so it only reads process environment
 * and the paths it is given. It never prints or returns secret values.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { envValue } from "../../../wizard/lib/paths.mjs";
import { isCognifyReady, providerMismatchWarning } from "./llm-env.mjs";
import { parseEnvText } from "./env-file.mjs";

const DEFAULT_PORT = "8766";

/** Read-only code root: PM_PACKAGE_ROOT (set by scripts/setup.mjs), else this module's checkout. */
function packageRoot() {
  const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  return path.resolve(process.env.PM_PACKAGE_ROOT || moduleRoot);
}

/** @param {string} home @param {NodeJS.ProcessEnv} env @param {string} [repo] */
function cogneeEnvFile(home, env, repo) {
  const value = env.COGNEE_ENV_FILE || (repo && envValue(path.join(repo, ".env"), "COGNEE_ENV_FILE"));
  if (!value) return path.join(home, ".config/personal-memory/cognee.env");
  return value.startsWith("~/") ? path.join(home, value.slice(2)) : path.resolve(repo || "", value);
}

/**
 * An env-file path from the environment as an absolute path: `~` is expanded and a relative
 * path is taken relative to the stack root, which is how compose resolves env_file.
 * @param {string} value @param {string} repo @param {string} home
 */
function absolutePath(value, repo, home) {
  if (/[\r\n\0]/.test(value)) throw new Error("an env file path must be a single line");
  const expanded = value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value;
  return path.resolve(repo, expanded);
}

/**
 * @param {{ repo: string, home?: string, env: NodeJS.ProcessEnv }} opts
 * @returns {{ entries: [string, string][], drop: string[], report: string[] }}
 *   entries: KEY=value lines to add to the stack .env; drop: keys to remove first (so a key is
 *   rewritten, never duplicated); report: KEY=value strings echoed in the "wrote .env" line
 */
export function prepareStackEnv({ repo, home = process.env.HOME || "", env }) {
  const stackEnv = path.join(repo, ".env");

  const port = env.COGNEE_PORT || envValue(stackEnv, "COGNEE_PORT") || DEFAULT_PORT;
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error(`COGNEE_PORT must be a number from 1 to 65535 (got: ${port})`);
  }

  const profiles = ["cognee"];
  const notebookYml = path.join(home, ".config/hindsight/notebooklm.yml");
  if (fs.existsSync(notebookYml) && /^enabled:\s*true\b/m.test(fs.readFileSync(notebookYml, "utf8"))) {
    profiles.push("notebooklm");
  }

  /** @type {[string, string][]} */
  const entries = [
    ["COGNEE_PORT", String(Number(port))],
    ["MEMORY_SINK", "cognee"],
    ["MEMORY_API_URL", "http://cognee:8000"],
    ["COMPOSE_PROFILES", profiles.join(",")],
  ];
  const drop = ["COGNEE_PORT", "COMPOSE_PROFILES", "MEMORY_SINK", "MEMORY_API_URL"];
  const report = [`COGNEE_PORT=${entries[0][1]}`, `COMPOSE_PROFILES=${profiles.join(",")}`];

  // Env files at a non-default location: persist the PATH (not its contents) so a hand-run
  // `docker compose` finds the same files. Absent from the environment, nothing is written and
  // an existing line is kept.
  for (const name of ["COGNEE_ENV_FILE", "COGNEE_INDEXER_ENV_FILE"]) {
    if (!env[name]) continue;
    const file = absolutePath(env[name], repo, home);
    entries.push([name, file]);
    drop.push(name);
    report.push(`${name}=${file}`);
  }

  // Compose interpolates every service before it filters by profile, so the root compose.yaml
  // requires LITELLM_CONFIG even under `--profile cognee`. The value is inert here: the litellm
  // service is gated by the profile "hindsight" and never starts for Cognee. Keep any value the
  // stack .env already has; otherwise honor the operator's process env; otherwise the shipped
  // config. An empty LITELLM_CONFIG= line is dropped so it is never duplicated.
  if (!envValue(stackEnv, "LITELLM_CONFIG")) {
    let litellmConfig = env.LITELLM_CONFIG;
    if (!litellmConfig) {
      litellmConfig = path.join(packageRoot(), "config", "litellm.lemond.yaml");
      if (!fs.existsSync(litellmConfig)) {
        throw new Error(`shipped config not found: ${litellmConfig}`);
      }
    }
    entries.push(["LITELLM_CONFIG", litellmConfig]);
    drop.push("LITELLM_CONFIG");
    report.push(`LITELLM_CONFIG=${litellmConfig}`);
  }
  return { entries, drop, report };
}

/**
 * Printed after the .env is written. Names the env file, never its contents.
 * @param {{ repo?: string, home: string, env: NodeJS.ProcessEnv }} opts
 * @returns {string[]}
 */
export function setupNotices({ repo, home, env }) {
  const file = cogneeEnvFile(home, env, repo);
  const notices = [];
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    // missing or unreadable: same notice as an empty file
  }
  const values = parseEnvText(text);
  if (!isCognifyReady(values)) {
    const mismatch = providerMismatchWarning(values);
    if (mismatch) notices.push(`NOTE: ${mismatch} in ${file}.`);
    notices.push(
      `NOTE: Cognee needs a cognify-ready config in ${file}: default is GRAPH_EXTRACTOR=gliner_demo ` +
        "with FastEmbed embeddings, or LLM_PROVIDER=ollama, or LLM_API_KEY. " +
        "Documents are stored but not searchable until cognify works.",
    );
  }
  try {
    if (fs.statSync(file).mode & 0o077) {
      notices.push(`NOTE: ${file} is readable by other users; run: chmod 600 ${file}`);
    }
  } catch {
    // no file: nothing to say about its mode
  }
  return notices;
}
