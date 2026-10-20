/**
 * Cognee's contribution to scripts/setup.mjs: the COGNEE_PORT entry of the stack .env, an inert
 * LITELLM_CONFIG entry, and the end-of-run notices about the Cognee env file.
 * Runs as a plain Node script step (no wizard context), so it only reads process environment
 * and the paths it is given. It never prints or returns secret values.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { envValue } from "../../../wizard/lib/paths.mjs";

const DEFAULT_PORT = "8766";

/** Read-only code root: PM_PACKAGE_ROOT (set by scripts/setup.mjs), else this module's checkout. */
function packageRoot() {
  const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  return path.resolve(process.env.PM_PACKAGE_ROOT || moduleRoot);
}

/** @param {string} home @param {NodeJS.ProcessEnv} env */
function cogneeEnvFile(home, env) {
  return env.COGNEE_ENV_FILE || path.join(home, ".config/personal-memory/cognee.env");
}

/**
 * @param {{ repo: string, home: string, env: NodeJS.ProcessEnv }} opts
 * @returns {{ entries: [string, string][], drop: string[], report: string[] }}
 *   entries: KEY=value lines to add to the stack .env; drop: keys to remove first (so a key is
 *   rewritten, never duplicated); report: KEY=value strings echoed in the "wrote .env" line
 */
export function prepareStackEnv({ repo, env }) {
  const stackEnv = path.join(repo, ".env");

  const port = env.COGNEE_PORT || envValue(stackEnv, "COGNEE_PORT") || DEFAULT_PORT;
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error(`COGNEE_PORT must be a number from 1 to 65535 (got: ${port})`);
  }

  /** @type {[string, string][]} */
  const entries = [
    ["COGNEE_PORT", String(Number(port))],
    // Plain `docker compose up -d` reads this; a stale COMPOSE_PROFILES=hindsight would start the wrong stack.
    ["COMPOSE_PROFILES", "cognee"],
  ];
  const drop = ["COGNEE_PORT", "COMPOSE_PROFILES"];
  const report = [`COGNEE_PORT=${entries[0][1]}`, "COMPOSE_PROFILES=cognee"];

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

/** True when the file has a KEY= line with a non-empty value (quotes and blanks do not count). */
function hasValue(text, key) {
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (!line.startsWith(`${key}=`)) continue;
    const value = line.slice(key.length + 1).trim().replace(/^(["'])(.*)\1$/, "$2").trim();
    if (value) return true;
  }
  return false;
}

/**
 * Printed after the .env is written. Names the env file, never its contents.
 * @param {{ home: string, env: NodeJS.ProcessEnv }} opts
 * @returns {string[]}
 */
export function setupNotices({ home, env }) {
  const file = cogneeEnvFile(home, env);
  const notices = [];
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    // missing or unreadable: same notice as an empty file
  }
  if (!hasValue(text, "LLM_API_KEY")) {
    notices.push(
      `NOTE: Cognee needs an LLM key to cognify: put LLM_API_KEY=... in ${file} (mode 600). ` +
        "Documents are stored but not searchable until it works.",
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
