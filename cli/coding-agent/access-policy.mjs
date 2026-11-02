import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic } from "./file-io.mjs";

/** Canonical hook / bank-mapping policy (docs/coding-agent-hooks.md). */
export const accessConfigPath = (home) => path.join(home, ".config", "personal-memory", "coding-agent.json");

/** Legacy indexer / Hindsight file; setup used to seed only this path. */
export const legacyAccessConfigPath = (home) => path.join(home, ".hindsight", "coding-agent.json");

/** Fields hooks and bank resolution read; copied from the legacy file when ensuring. */
export const ACCESS_POLICY_KEYS = ["disabled", "optInOnly", "optInPaths", "mapPathToBank"];

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Validate shape; null means unreadable / malformed (deny). */
function validateAccessConfig(config) {
  if (!isPlainObject(config)) return null;
  if ("disabled" in config && typeof config.disabled !== "boolean") return null;
  if ("optInOnly" in config && typeof config.optInOnly !== "boolean") return null;
  if ("optInPaths" in config && (!Array.isArray(config.optInPaths)
    || config.optInPaths.some((p) => typeof p !== "string" || !p.trim() || !path.isAbsolute(p)))) return null;
  if ("mapPathToBank" in config && (!isPlainObject(config.mapPathToBank)
    || Object.entries(config.mapPathToBank).some(([prefix, bank]) => !prefix.trim() || !path.isAbsolute(prefix)
      || typeof bank !== "string" || !bank.trim()))) return null;
  return config;
}

function readJsonObject(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return isPlainObject(raw) ? raw : null;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    return null;
  }
}

/** Pick the access-policy fields from a legacy or openmem object. */
export function pickAccessPolicyFields(source) {
  if (!isPlainObject(source)) return {};
  const out = {};
  for (const key of ACCESS_POLICY_KEYS) {
    if (key in source) out[key] = source[key];
  }
  return out;
}

/** Read policy config. A missing file keeps the historical device-wide default; all other read/parse errors deny. */
export function readAccessConfig(home) {
  try {
    const config = JSON.parse(fs.readFileSync(accessConfigPath(home), "utf8"));
    return validateAccessConfig(config);
  } catch (error) {
    return error?.code === "ENOENT" ? {} : null;
  }
}

function writeAccessConfig(file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileAtomic(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Ensure `~/.config/personal-memory/coding-agent.json` exists.
 * Prefer an existing openmem file. If missing, copy access fields from `~/.hindsight/coding-agent.json`
 * when that file is present and valid; otherwise create `{}` (hooks allow all — historical default).
 * Returns { path, action: "exists"|"migrated"|"created"|"dry-run", config }.
 */
export function ensureAccessConfig(home, { dry = false } = {}) {
  const file = accessConfigPath(home);
  const existing = readJsonObject(file);
  if (existing !== undefined) {
    const config = validateAccessConfig(existing) || {};
    return { path: file, action: "exists", config };
  }

  const legacyRaw = readJsonObject(legacyAccessConfigPath(home));
  let config = {};
  let action = "created";
  if (legacyRaw !== undefined) {
    const picked = pickAccessPolicyFields(legacyRaw);
    const validated = validateAccessConfig({ ...picked });
    if (validated) {
      config = pickAccessPolicyFields(validated);
      action = Object.keys(config).length ? "migrated" : "created";
    }
  }

  if (dry) return { path: file, action: "dry-run", config, would: action };
  writeAccessConfig(file, config);
  return { path: file, action, config };
}

/**
 * Copy access-policy fields from the legacy Hindsight file into the openmem file (create or update).
 * Preserves unrelated keys already on the openmem file. Used after wizard edits of optInPaths.
 */
export function syncAccessPolicyFromLegacy(home, { dry = false } = {}) {
  const file = accessConfigPath(home);
  const legacyRaw = readJsonObject(legacyAccessConfigPath(home));
  if (legacyRaw === undefined) return ensureAccessConfig(home, { dry });
  const picked = pickAccessPolicyFields(legacyRaw);
  const validated = validateAccessConfig({ ...picked });
  if (!validated) return ensureAccessConfig(home, { dry });
  const fields = pickAccessPolicyFields(validated);
  const existing = readJsonObject(file);
  const config = { ...(isPlainObject(existing) ? existing : {}), ...fields };
  if (dry) return { path: file, action: "dry-run", config, would: existing === undefined ? "migrated" : "synced" };
  writeAccessConfig(file, config);
  return { path: file, action: existing === undefined ? "migrated" : "synced", config };
}

export function accessAllowed(cwd, config) {
  if (!config || typeof cwd !== "string" || !cwd.trim() || !path.isAbsolute(cwd) || config.disabled === true) return false;
  if (config.optInOnly !== true) return true;
  const dir = path.resolve(cwd);
  return (config.optInPaths || []).some((configured) => {
    const allowed = path.resolve(configured);
    return dir === allowed || dir.startsWith(`${allowed}${path.sep}`);
  });
}

export function currentHome() {
  return process.env.HOME || os.homedir();
}
