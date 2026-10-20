import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { die } from "../log.mjs";

const DEFAULT_PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

/** Provider used when nothing selects one. */
export const DEFAULT_PROVIDER_ID = "hindsight";

const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
/** Same rule as indexer/sinks/__init__.py NAME: the sink module name and the MEMORY_SINK value. */
const SINK_NAME_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Directory that holds `<id>/manifest.json` and `<id>/wizard.mjs`. Read-only code root.
 * PM_PROVIDERS_DIR (tests, fixtures) beats PM_PACKAGE_ROOT/providers, which beats the
 * checkout this module lives in.
 */
export function providersRoot() {
  if (process.env.PM_PROVIDERS_DIR) return path.resolve(process.env.PM_PROVIDERS_DIR);
  return path.join(process.env.PM_PACKAGE_ROOT || DEFAULT_PACKAGE_ROOT, "providers");
}

/** @typedef {object} ProviderManifest
 * @property {string} id
 * @property {string} label
 * @property {"supported"|"experimental"|"planned"} status
 * @property {{ services?: string[], healthService?: string|null, healthPath?: string, hostPortEnv?: string, defaultHostPort?: number, profile?: string, files?: string[], logServices?: string[] }} compose
 *   `profile` adds `--profile <profile>` to every compose call; `files` are extra `-f`
 *   compose files relative to the stack root, added after compose.yaml.
 * @property {object} indexer
 * @property {object} codingAgent
 * @property {object} wizard
 * @property {{ module?: string, delegates?: Record<string, object> }} [wizardHooks]
 */

/** @type {Map<string, ProviderManifest|null>} */
const cache = new Map();

/**
 * @param {string} id
 * @returns {ProviderManifest|null}
 */
export function loadManifest(id) {
  if (!PROVIDER_ID_RE.test(String(id))) return null;
  const file = path.join(providersRoot(), id, "manifest.json");
  if (cache.has(file)) return cache.get(file);
  if (!fs.existsSync(file)) return null;
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  cache.set(file, manifest);
  return manifest;
}

/** @returns {string[]} */
export function listProviderIds() {
  const root = providersRoot();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter(
      (d) =>
        d.isDirectory() &&
        !d.name.startsWith("_") &&
        fs.existsSync(path.join(root, d.name, "manifest.json")),
    )
    .map((d) => d.name)
    .sort();
}

/** @returns {ProviderManifest[]} */
export function listAllProviders() {
  return listProviderIds()
    .map((id) => loadManifest(id))
    .filter(Boolean);
}

/** @returns {ProviderManifest[]} */
export function listSelectableProviders() {
  return listAllProviders().filter(
    (m) => m.status === "supported" || m.status === "experimental",
  );
}

/** @returns {ProviderManifest[]} */
export function listPlannedProviders() {
  return listAllProviders().filter((m) => m.status === "planned");
}

/**
 * @param {import("../run-wizard.mjs").WizardContext} ctx
 * @param {Record<string, string>} [machine]
 */
export function providerDefaultId(ctx, machine = {}) {
  const fromConf = ctx.wizardConf && fs.existsSync(ctx.wizardConf)
    ? readConfKey(ctx.wizardConf, "MEMORY_PROVIDER")
    : "";
  const fromToml = ctx.pmMerged
    ? String(/** @type {Record<string, unknown>} */ (ctx.pmMerged.memory || {}).provider || "")
    : "";
  return (
    process.env.MEMORY_PROVIDER ||
    process.env.PM_MEMORY_PROVIDER ||
    fromToml ||
    machine.MEMORY_PROVIDER ||
    fromConf ||
    DEFAULT_PROVIDER_ID
  );
}

function readConfKey(file, key) {
  const prefix = `${key}=`;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
  }
  return "";
}

/**
 * @param {string} [explicitId]
 * @param {{ allowPlanned?: boolean }} [opts]
 * @returns {ProviderManifest}
 */
export function resolveProvider(explicitId, opts = {}) {
  const fromEnv =
    explicitId ||
    process.env.MEMORY_PROVIDER ||
    process.env.PM_MEMORY_PROVIDER ||
    DEFAULT_PROVIDER_ID;
  const manifest = loadManifest(fromEnv);
  if (!manifest) die(`unknown memory provider '${fromEnv}' (see providers/*/manifest.json)`);
  if (manifest.status === "planned" && !opts.allowPlanned) {
    die(
      `memory provider '${fromEnv}' is not implemented yet (${manifest.label}); pick a supported provider in ./setup or see docs/memory-providers.md`,
    );
  }
  return manifest;
}

/** @param {unknown} v */
function isStringArray(v) {
  return Array.isArray(v) && v.every((s) => typeof s === "string" && s.length > 0);
}

/**
 * A compose file path from the manifest must stay inside the stack root.
 * @param {string} f
 */
function isStackRelativePath(f) {
  if (path.isAbsolute(f) || f.includes("\0")) return false;
  const norm = path.posix.normalize(f.replace(/\\/g, "/"));
  return norm !== ".." && !norm.startsWith("../") && norm !== ".";
}

/**
 * @param {ProviderManifest} manifest
 * @returns {string[]}
 */
export function validateManifest(manifest) {
  const errors = [];
  if (!manifest.id) errors.push("missing id");
  else if (!PROVIDER_ID_RE.test(manifest.id)) errors.push(`invalid id: ${manifest.id}`);
  if (!manifest.label) errors.push("missing label");
  if (!["supported", "experimental", "planned"].includes(manifest.status)) {
    errors.push(`invalid status: ${manifest.status}`);
  }
  if (manifest.status === "supported" || manifest.status === "experimental") {
    const w = manifest.wizard || {};
    for (const key of [
      "smokeBank",
      "retainPath",
      "recallPath",
      "deletePath",
      "retainBody",
      "recallBody",
    ]) {
      if (!w[key]) errors.push(`wizard.${key} required for ${manifest.status}`);
    }
    if (!manifest.compose?.healthPath) errors.push("compose.healthPath required");
    if (!manifest.indexer?.sinkDriver) errors.push("indexer.sinkDriver required");
    if (!manifest.indexer?.sink) errors.push("indexer.sink required");
  }
  const sink = manifest.indexer?.sink;
  if (sink !== undefined && (typeof sink !== "string" || !SINK_NAME_RE.test(sink))) {
    errors.push(`indexer.sink must match ${SINK_NAME_RE} (got ${JSON.stringify(sink)})`);
  }

  const compose = manifest.compose;
  if (compose !== undefined) {
    if (compose === null || typeof compose !== "object" || Array.isArray(compose)) {
      errors.push("compose must be an object");
    } else {
      if (compose.profile !== undefined) {
        if (typeof compose.profile !== "string" || !PROFILE_RE.test(compose.profile)) {
          errors.push(`compose.profile must match ${PROFILE_RE} (got ${JSON.stringify(compose.profile)})`);
        }
      }
      if (compose.files !== undefined) {
        if (!isStringArray(compose.files)) {
          errors.push("compose.files must be an array of non-empty strings");
        } else {
          for (const f of compose.files) {
            if (!isStackRelativePath(f)) {
              errors.push(`compose.files entry must be a path inside the stack root: ${f}`);
            }
          }
        }
      }
      for (const key of ["services", "logServices"]) {
        if (compose[key] !== undefined && !isStringArray(compose[key])) {
          errors.push(`compose.${key} must be an array of non-empty strings`);
        }
      }
    }
  }
  if (manifest.wizardHooks?.module !== undefined) {
    const mod = manifest.wizardHooks.module;
    if (typeof mod !== "string" || !mod || path.isAbsolute(mod) || mod.split(/[\\/]/).includes("..")) {
      errors.push("wizardHooks.module must be a relative path inside the provider directory");
    }
  }
  if (manifest.wizard?.recallHint !== undefined && typeof manifest.wizard.recallHint !== "string") {
    errors.push("wizard.recallHint must be a string");
  }
  if (manifest.wizard?.retainHint !== undefined && typeof manifest.wizard.retainHint !== "string") {
    errors.push("wizard.retainHint must be a string");
  }
  for (const key of ["smokeRetainTimeoutSec", "smokeRecallTimeoutSec"]) {
    const v = manifest.wizard?.[key];
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v <= 0)) {
      errors.push(`wizard.${key} must be a positive number`);
    }
  }
  return errors;
}

/**
 * @param {ProviderManifest} provider
 * @param {string} bank
 * @param {string} template
 */
export function expandPath(provider, bank, template) {
  if (!template) return "";
  return template.replace(/\{bank\}/g, encodeURIComponent(bank));
}

/**
 * Base URL of the provider's HTTP API on this host, from the manifest's
 * `compose.hostPortEnv` and `compose.defaultHostPort`. A provider that needs more
 * (a remote URL, a path prefix) implements the `apiBase` hook instead.
 * @param {import("../run-wizard.mjs").WizardContext} ctx
 * @param {ProviderManifest} provider
 */
export function providerApiBase(ctx, provider) {
  if (ctx.apiUrl) return ctx.apiUrl;
  const portEnv = provider.compose.hostPortEnv;
  const port =
    (portEnv && process.env[portEnv]) || String(provider.compose.defaultHostPort ?? 8888);
  return `http://127.0.0.1:${port}`;
}
