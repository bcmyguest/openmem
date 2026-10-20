import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { info, warn } from "../log.mjs";
import { providersRoot } from "../providers/registry.mjs";

/** @type {Map<string, Record<string, unknown>>} */
const moduleCache = new Map();

/**
 * Absolute path of the provider's hook module, or "" when the manifest points outside
 * the provider directory.
 * @param {import('../providers/registry.mjs').ProviderManifest} manifest
 */
export function wizardModulePath(manifest) {
  const dir = path.resolve(providersRoot(), manifest.id);
  const file = path.resolve(dir, manifest.wizardHooks?.module || "wizard.mjs");
  return file.startsWith(`${dir}${path.sep}`) ? file : "";
}

/**
 * Import `providers/<id>/wizard.mjs` (cached per file). A provider without the module
 * gets an empty export set, so every phase is a no-op for it.
 * @param {import('../providers/registry.mjs').ProviderManifest} manifest
 * @returns {Promise<Record<string, unknown>>}
 */
export async function loadProviderWizard(manifest) {
  const file = wizardModulePath(manifest);
  if (!file || !fs.existsSync(file)) return {};
  if (moduleCache.has(file)) return moduleCache.get(file);
  const mod = await import(pathToFileURL(file).href);
  moduleCache.set(file, mod);
  return mod;
}

/** @typedef {keyof typeof PROVIDER_PHASES} ProviderPhase */

/**
 * Hook names a provider module may export. Phases in ANNOUNCED print
 * "provider <id>: <phase>" when they run; the rest are quiet queries.
 */
export const PROVIDER_PHASES = {
  // v1 phases (unchanged)
  afterProvider: "afterProvider",
  configureModelRouting: "configureModelRouting",
  beforeStack: "beforeStack",
  afterStackHealthy: "afterStackHealthy",
  extendValidation: "extendValidation",
  // v2 phases
  init: "init",
  resolvePorts: "resolvePorts",
  setupEnv: "setupEnv",
  stackEnv: "stackEnv",
  hydrate: "hydrate",
  configToml: "configToml",
  summary: "summary",
  apiBase: "apiBase",
  smoke: "smoke",
  setupCodingAgent: "setupCodingAgent",
};

const ANNOUNCED = new Set([
  PROVIDER_PHASES.afterProvider,
  PROVIDER_PHASES.configureModelRouting,
  PROVIDER_PHASES.beforeStack,
  PROVIDER_PHASES.afterStackHealthy,
  PROVIDER_PHASES.extendValidation,
  PROVIDER_PHASES.resolvePorts,
  PROVIDER_PHASES.setupEnv,
  PROVIDER_PHASES.smoke,
  PROVIDER_PHASES.setupCodingAgent,
]);

/**
 * Call a provider hook and return its result. A provider that does not export the phase
 * is a clean no-op: `{ ran: false }`.
 * @param {import('../run-wizard.mjs').WizardContext} ctx
 * @param {string} phase
 * @param {import('./helpers.mjs').ProviderWizardHelpers} helpers
 * @returns {Promise<{ ran: boolean, value?: any }>}
 */
export async function callProviderHook(ctx, phase, helpers) {
  const manifest = ctx.memoryProvider;
  if (!manifest) return { ran: false };
  const mod = await loadProviderWizard(manifest);
  const fn = mod[phase];
  if (typeof fn !== "function") return { ran: false };
  if (ANNOUNCED.has(phase)) info(`provider ${manifest.id}: ${phase}`);
  return { ran: true, value: await fn(ctx, helpers) };
}

/**
 * @param {import('../run-wizard.mjs').WizardContext} ctx
 * @param {string} phase
 * @param {import('./helpers.mjs').ProviderWizardHelpers} helpers
 * @returns {Promise<boolean>} whether the provider implements the phase
 */
export async function runProviderPhase(ctx, phase, helpers) {
  return (await callProviderHook(ctx, phase, helpers)).ran;
}

/**
 * @param {import('../run-wizard.mjs').WizardContext} ctx
 * @param {string} commandId
 */
export async function runDelegatedCommand(ctx, commandId) {
  const manifest = ctx.memoryProvider;
  const delegates = manifest?.wizardHooks?.delegates || {};
  const spec = delegates[commandId];
  if (!spec?.run?.length) {
    warn(`provider ${manifest?.id}: no delegate '${commandId}'`);
    return false;
  }
  const [cmd, ...args] = spec.run;
  info(`delegate ${manifest.id}/${commandId}: ${cmd} ${args.join(" ")}`);
  if (ctx.dry) {
    info(`[dry-run] ${cmd} ${args.join(" ")}`);
    return true;
  }
  const r = spawnSync(cmd, args, { stdio: "inherit", env: process.env });
  if (r.status !== 0) process.exit(r.status ?? 1);
  return true;
}

/** @param {import('../providers/registry.mjs').ProviderManifest} manifest @returns {string[]} */
export function listDelegateCommands(manifest) {
  return Object.keys(manifest.wizardHooks?.delegates || {});
}
