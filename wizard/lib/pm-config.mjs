import fs from "node:fs";
import path from "node:path";
import TOML from "@iarna/toml";
import { DEFAULT_PROVIDER_ID } from "./providers/registry.mjs";

/** @param {string} home */
export function userConfigPath(home) {
  return path.join(home, ".config/personal-memory/config.toml");
}

/** @param {string} repoRoot */
export function projectConfigPaths(repoRoot) {
  return [
    path.join(repoRoot, "personal-memory.toml"),
    path.join(repoRoot, "config/personal-memory.toml"),
  ];
}

/**
 * @param {string} file
 * @returns {Record<string, unknown>}
 */
function readTomlFile(file) {
  if (!fs.existsSync(file)) return {};
  try {
    return TOML.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file}: ${/** @type {Error} */ (e).message}`);
  }
}

/** @param {Record<string, unknown>} base @param {Record<string, unknown>} over */
function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object") {
      out[k] = deepMerge(/** @type {Record<string, unknown>} */ (out[k]), /** @type {Record<string, unknown>} */ (v));
    } else out[k] = v;
  }
  return out;
}

/**
 * @param {string} home
 * @param {string} repoRoot
 * @returns {{ merged: Record<string, unknown>, userPath: string, wroteFrom: string[] }}
 */
export function loadPmConfig(home, repoRoot) {
  let merged = {};
  const wroteFrom = [];
  for (const p of projectConfigPaths(repoRoot)) {
    if (fs.existsSync(p)) {
      merged = deepMerge(merged, readTomlFile(p));
      wroteFrom.push(p);
    }
  }
  const userPath = userConfigPath(home);
  if (fs.existsSync(userPath)) {
    merged = deepMerge(merged, readTomlFile(userPath));
    wroteFrom.push(userPath);
  }
  return { merged, userPath, wroteFrom };
}

/**
 * Flat defaults for the wizard (--yes / Clack initialValue). Provider-specific tables
 * ([model], provider ports) are read by the provider's own hooks from `cfg`.
 * @param {Record<string, unknown>} cfg
 */
export function defaultsFromPmConfig(cfg) {
  const memory = /** @type {Record<string, unknown>} */ (cfg.memory || {});
  const stack = /** @type {Record<string, unknown>} */ (cfg.stack || {});
  const wizard = /** @type {Record<string, unknown>} */ (cfg.wizard || {});

  return {
    memoryProvider: String(memory.provider || ""),
    stackProject: String(stack.project || ""),
    wizardAction: String(wizard.action || ""),
  };
}

/**
 * @param {import("./run-wizard.mjs").WizardContext} ctx
 * @param {Record<string, Record<string, unknown>>} [sections] provider-owned tables:
 *   `stack` keys are merged into [stack]; every other key becomes its own top-level table
 * @returns {string}
 */
export function buildPmConfigToml(ctx, sections = {}) {
  const { stack: stackExtra = {}, ...rest } = sections;
  const doc = {
    memory: { provider: ctx.memoryProvider?.id || DEFAULT_PROVIDER_ID },
    stack: { project: ctx.project, ...stackExtra },
    wizard: { action: ctx.action || "configure" },
    ...rest,
    tasks: {
      configure: { description: "Secrets, index sources, build images, compose up" },
      up: { description: "Start stack using existing config" },
      down: { description: "docker compose down for this project" },
      doctor: { description: "Validate memory setup on this machine" },
    },
  };
  return `# Written by ./setup — mise-like config for personal-memory.\n# Docs: docs/personal-memory-config.md\n${TOML.stringify(doc)}`;
}

/**
 * @param {import("./run-wizard.mjs").WizardContext} ctx
 * @param {Record<string, Record<string, unknown>>} [sections] see buildPmConfigToml
 */
export function syncPmConfig(ctx, sections = {}) {
  if (ctx.dry) return;
  const dir = path.dirname(userConfigPath(ctx.home));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = userConfigPath(ctx.home);
  fs.writeFileSync(file, buildPmConfigToml(ctx, sections), { mode: 0o600 });
}

/**
 * Apply config defaults into process.env when env/CLI did not set them. Only the
 * provider-neutral keys live here; a provider maps its own tables in its `init` hook.
 * @param {Record<string, unknown>} cfg
 */
export function applyPmConfigEnv(cfg) {
  const d = defaultsFromPmConfig(cfg);
  if (d.memoryProvider && !process.env.MEMORY_PROVIDER) {
    process.env.MEMORY_PROVIDER = d.memoryProvider;
  }
  if (d.stackProject && !process.env.PM_PROJECT) process.env.PM_PROJECT = d.stackProject;
  if (d.wizardAction && !process.env.PM_WIZARD_ACTION) {
    process.env.PM_WIZARD_ACTION = d.wizardAction;
  }
}
