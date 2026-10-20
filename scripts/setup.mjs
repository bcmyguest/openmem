#!/usr/bin/env node
/**
 * Write the stack .env (HOST_UID, HOST_GID and provider entries) and compose.override.yaml.
 *
 * PM_STACK_ROOT (default: this checkout) is the mutable stack directory; the provider
 * comes from MEMORY_PROVIDER (default: hindsight) and is loaded from the read-only code
 * root (PM_PACKAGE_ROOT, else this checkout). A provider contributes through optional
 * exports of providers/<id>/wizard.mjs:
 *   prepareStackEnv({ repo, home, env }) -> { entries, drop, report }
 *   migrateEnv({ repo, home, env })      (for --migrate-env)
 *   setupNotices({ repo, home, env })    -> string[]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_PROVIDER_ID,
  loadManifest,
} from "../wizard/lib/providers/registry.mjs";
import { wizardModulePath } from "../wizard/lib/provider-wizard/run-steps.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(process.env.PM_PACKAGE_ROOT || path.join(scriptDir, ".."));
const repo = path.resolve(process.env.PM_STACK_ROOT || packageRoot);
const home = process.env.HOME || os.homedir();
const envFile = path.join(repo, ".env");
const tmp = `${envFile}.tmp`;
const migrate = process.argv.includes("--migrate-env");
process.env.PM_PACKAGE_ROOT = packageRoot;

const providerId = process.env.MEMORY_PROVIDER || DEFAULT_PROVIDER_ID;
const manifest = loadManifest(providerId);
if (!manifest) {
  console.error(`unknown memory provider '${providerId}' (see providers/*/manifest.json)`);
  process.exit(1);
}
const modFile = wizardModulePath(manifest);
const provider = modFile && fs.existsSync(modFile) ? await import(pathToFileURL(modFile).href) : {};
const opts = { repo, home, env: process.env };

/** @type {{ entries: [string, string][], drop: string[], report: string[] }} */
let spec = { entries: [], drop: [], report: [] };
try {
  fs.mkdirSync(path.join(home, ".config/hindsight"), { recursive: true, mode: 0o700 });
  if (typeof provider.prepareStackEnv === "function") {
    spec = { ...spec, ...(await provider.prepareStackEnv(opts)) };
  }
} catch (e) {
  console.error(/** @type {Error} */ (e).message);
  process.exit(1);
}

const dropRe = new RegExp(`^(${["HOST_UID", "HOST_GID", ...spec.drop].join("|")})=`);

const kept = [];
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    if (line && !dropRe.test(line)) kept.push(line);
  }
}
const uid = os.userInfo().uid;
const gid = os.userInfo().gid;
kept.push(`HOST_UID=${uid}`, `HOST_GID=${gid}`);
for (const [key, value] of spec.entries) kept.push(`${key}=${value}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(tmp, `${kept.filter(Boolean).join("\n")}\n`, { mode: 0o644 });
fs.renameSync(tmp, envFile);
console.log(`wrote ${envFile}: ${[`HOST_UID=${uid}`, `HOST_GID=${gid}`, ...spec.report].join(" ")}`);

const gen = spawnSync(process.execPath, [path.join(scriptDir, "gen-masks.mjs")], {
  stdio: "inherit",
  env: { ...process.env, PM_STACK_ROOT: repo },
});
if (gen.status !== 0) process.exit(gen.status ?? 1);

if (migrate) {
  if (typeof provider.migrateEnv !== "function") {
    console.error(`provider ${providerId} has no --migrate-env step`);
    process.exit(1);
  }
  try {
    await provider.migrateEnv(opts);
  } catch (e) {
    console.error(/** @type {Error} */ (e).message);
    process.exit(1);
  }
  process.exit(0);
}

if (typeof provider.setupNotices === "function") {
  for (const line of await provider.setupNotices(opts)) console.log(line);
}
