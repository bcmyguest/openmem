/**
 * mem0's contribution to scripts/setup.mjs: the stack .env entries that point the indexer at an
 * existing mem0 server, and the end-of-run notices about the indexer's API key file and about
 * a loopback-only server. Runs as a plain Node script step (no wizard context), so it only reads
 * process environment and the paths it is given. It never reads or prints the key.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { envValue } from "../../../wizard/lib/paths.mjs";

/** Hostnames that mean "this machine" on the host and so must become the host gateway in a container. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "0.0.0.0", "[::1]"]);

/** Appended to every URL error. The messages never echo the URL, which may hold a secret. */
const SECRET_HINT = "put MEM0_API_KEY in the mem0 env file instead of the URL";

/**
 * Parse and validate the mem0 server URL as the operator's host sees it.
 * @param {string} hostUrl
 * @returns {URL}
 */
function parseHostUrl(hostUrl) {
  const text = String(hostUrl ?? "").trim();
  // The URL parser silently drops tabs and newlines, so check the raw text: a newline would
  // otherwise let one value write a second KEY=value line into the stack .env.
  if (/[\x00-\x20\x7f]/.test(text)) {
    throw new Error(`MEM0_API_URL must not contain spaces or control characters; ${SECRET_HINT}`);
  }
  if (text.includes("$")) {
    throw new Error(`MEM0_API_URL must not contain '$' (compose would interpolate it); ${SECRET_HINT}`);
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error("MEM0_API_URL is not a valid URL (expected http://host:port or https://host:port)");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`MEM0_API_URL must use http or https (got: ${url.protocol.replace(":", "")})`);
  }
  if (url.username || url.password) {
    // The stack .env is world-readable; secrets belong in the mode 600 env file.
    throw new Error(`MEM0_API_URL must not contain credentials; ${SECRET_HINT}`);
  }
  if (url.search || url.hash) {
    throw new Error(`MEM0_API_URL must not contain a query or fragment; ${SECRET_HINT}`);
  }
  return url;
}

/**
 * The normalized host-view URL (scheme, host, port and path; no trailing slash). This is what
 * the stack .env stores as MEM0_API_URL, never the raw string.
 * @param {string} hostUrl
 * @returns {string}
 */
export function normalizeHostUrl(hostUrl) {
  return parseHostUrl(hostUrl).toString().replace(/\/+$/, "");
}

/**
 * The server URL as the indexer container sees it: loopback hosts become host.docker.internal;
 * scheme, port and path are kept and a trailing slash is removed.
 * @param {string} hostUrl URL as the operator's host sees it (for example http://127.0.0.1:18888)
 * @returns {string}
 */
export function indexerUrl(hostUrl) {
  const url = parseHostUrl(hostUrl);
  if (LOOPBACK_HOSTS.has(url.hostname)) url.hostname = "host.docker.internal";
  return url.toString().replace(/\/+$/, "");
}

/** Absolute path of the shipped LiteLLM config under the code root. */
function shippedLitellmConfig() {
  const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const root = path.resolve(process.env.PM_PACKAGE_ROOT || moduleRoot);
  const file = path.join(root, "config", "litellm.lemond.yaml");
  if (!fs.existsSync(file)) {
    throw new Error("shipped config/litellm.lemond.yaml missing: broken install");
  }
  return file;
}

/**
 * @param {{ repo: string, home: string, env: NodeJS.ProcessEnv }} opts
 * @returns {{ entries: [string, string][], drop: string[], report: string[] }}
 *   entries: KEY=value lines to add to the stack .env; drop: keys to remove first;
 *   report: KEY=value strings echoed in the "wrote .env" line
 */
export function prepareStackEnv({ repo, env }) {
  const stackEnv = path.join(repo, ".env");
  const rawUrl = (env.MEM0_API_URL || envValue(stackEnv, "MEM0_API_URL")).trim();
  if (!rawUrl) {
    throw new Error(
      "MEM0_API_URL is required (the mem0 server URL as this host sees it, e.g. http://127.0.0.1:18888); " +
        "the wizard sets it before running setup",
    );
  }
  const hostUrl = normalizeHostUrl(rawUrl);
  const containerUrl = indexerUrl(rawUrl);

  // compose.yaml interpolates every service before it filters by profile, and `litellm` mounts
  // ${LITELLM_CONFIG:?...}. litellm is gated by the profile "hindsight", so under the mem0 profile it never
  // runs and the value is inert; it only has to be set (to an existing file) for `docker compose config`
  // and `up` to get past interpolation. Precedence: the operator's process env, then a non-empty value
  // already in the stack .env, then the shipped config. LITELLM_CONFIG is always dropped and rewritten, which
  // also removes an empty `LITELLM_CONFIG=` line that would still fail the `:?` check.
  const litellmConfig =
    (env.LITELLM_CONFIG || "").trim() || envValue(stackEnv, "LITELLM_CONFIG").trim() || shippedLitellmConfig();

  /** @type {[string, string][]} */
  const entries = [
    ["MEM0_API_URL", hostUrl],
    ["MEM0_INDEXER_URL", containerUrl],
    // Like Hindsight, name the profile in the stack .env so a plain `docker compose config` agrees with the wizard.
    ["COMPOSE_PROFILES", "mem0"],
    ["LITELLM_CONFIG", litellmConfig],
  ];
  return {
    entries,
    drop: ["MEM0_API_URL", "MEM0_INDEXER_URL", "COMPOSE_PROFILES", "LITELLM_CONFIG"],
    report: [`MEM0_INDEXER_URL=${containerUrl}`, `COMPOSE_PROFILES=mem0`, `LITELLM_CONFIG=${litellmConfig}`],
  };
}

/**
 * Printed at the end of setup: the indexer's mem0 key file is missing, has no key or is too open,
 * and the server URL points at a loopback address the container may not reach.
 * @param {{ repo?: string, home: string, env: NodeJS.ProcessEnv }} opts
 * @returns {string[]}
 */
export function setupNotices({ repo, home, env }) {
  const file = env.MEM0_ENV_FILE || path.join(home, ".config/personal-memory/mem0.env");
  const hasKey = fs.existsSync(file) && /^MEM0_API_KEY=\S/m.test(fs.readFileSync(file, "utf8"));
  /** @type {string[]} */
  const notes = [];
  if (!hasKey) {
    notes.push(
      `NOTE: mem0 needs an API key for the indexer: put MEM0_API_KEY=... in ${file} (mode 600).`,
      "      Not needed when the server runs with AUTH_DISABLED.",
    );
  }
  if (fs.existsSync(file)) {
    const mode = fs.statSync(file).mode & 0o777;
    if (mode & 0o077) {
      notes.push(
        `NOTE: ${file} is readable by group or others (mode ${mode.toString(8)}). Run: chmod 600 ${file}`,
      );
    }
  }

  const rawUrl = (env.MEM0_API_URL || (repo ? envValue(path.join(repo, ".env"), "MEM0_API_URL") : "")).trim();
  if (rawUrl) {
    try {
      const url = parseHostUrl(rawUrl);
      if (LOOPBACK_HOSTS.has(url.hostname)) {
        notes.push(
          "NOTE: MEM0_API_URL is a loopback address; the indexer container reaches it as host.docker.internal.",
          "      On Linux a mem0 server bound only to 127.0.0.1 is NOT reachable that way: bind it to 0.0.0.0",
          "      or the docker bridge IP, or use a hostname in MEM0_API_URL.",
        );
        if (url.protocol === "https:") {
          notes.push(
            "      An https loopback URL becomes host.docker.internal, which will not match the server certificate name.",
          );
        }
      }
    } catch {
      // prepareStackEnv already rejected an unusable URL; nothing to add here.
    }
  }
  return notes;
}
