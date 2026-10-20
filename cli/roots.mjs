/**
 * Shared root and dependency handling for wizard/bin/setup.mjs and wizard/bin/pm.mjs.
 *
 * Contract (see docs/npx-install.md):
 *   PM_STACK_ROOT    mutable stack root = the wizard's ctx.repoRoot (compose project dir,
 *                    .env, generated files, docker build context)
 *   PM_PACKAGE_ROOT  read-only code root (providers/ manifests and hooks, scripts/setup.mjs,
 *                    wizard/lib)
 * Unset, both default to the checkout root derived from the bin file's location.
 *
 * Node builtins only: this module runs before the wizard dependencies are verified.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Compute both roots from the location of a file in wizard/bin and export them to the
 * environment so child processes (scripts/setup.mjs, docker compose helpers) see them.
 *
 * @param {string} binFileUrl import.meta.url of wizard/bin/<file>.mjs
 * @returns {{ pkgRoot: string, repo: string, packaged: boolean }}
 */
export function resolveWizardRoots(binFileUrl) {
  const here = path.dirname(fileURLToPath(binFileUrl));
  const derived = path.resolve(here, "../..");
  const pkgRoot = path.resolve(process.env.PM_PACKAGE_ROOT || derived);
  const repo = path.resolve(process.env.PM_STACK_ROOT || derived);
  const packaged = derived.split(path.sep).includes("node_modules");
  if (packaged && !process.env.PM_STACK_ROOT) {
    console.error(
      "personal-memory: this copy lives in an npm package directory, which is read-only and\n" +
        "may be garbage-collected. Run it through the CLI instead (it sets up a stable stack root):\n" +
        "  npx personal-memory   |   personal-memory   |   PM_STACK_ROOT=<dir> to choose one",
    );
    process.exit(1);
  }
  process.env.PM_PACKAGE_ROOT = pkgRoot;
  process.env.PM_STACK_ROOT = repo;
  return { pkgRoot, repo, packaged };
}

/**
 * Is `name` resolvable from a file inside `fromDir`? Checks node_modules lookup
 * directories on disk, so it works for ESM-only packages and hoisted installs.
 *
 * @param {string} fromDir
 * @param {string} name
 */
function resolvable(fromDir, name) {
  const req = createRequire(path.join(fromDir, "noop.js"));
  const dirs = req.resolve.paths(name) || [];
  return dirs.some((d) => fs.existsSync(path.join(d, name, "package.json")));
}

/**
 * Make sure the wizard dependencies resolve. Packaged installs get them from npm; a
 * checkout runs `npm install` once at the checkout root.
 *
 * @param {string} pkgRoot
 * @param {boolean} packaged
 */
export function ensureWizardDeps(pkgRoot, packaged) {
  const wizardDir = path.join(pkgRoot, "wizard", "bin");
  const needed = ["@clack/prompts", "@iarna/toml"];
  const missing = needed.filter((n) => !resolvable(wizardDir, n));
  if (!missing.length) return;
  if (packaged || !fs.existsSync(path.join(pkgRoot, "package.json"))) {
    console.error(
      `personal-memory: missing dependencies (${missing.join(", ")}); reinstall the package.`,
    );
    process.exit(1);
  }
  if (process.stderr.isTTY) process.stderr.write("Installing setup dependencies...\n");
  const r = spawnSync("npm", ["install", "--no-fund", "--no-audit"], {
    cwd: pkgRoot,
    stdio: "inherit",
  });
  if (r.status !== 0) {
    console.error(`npm install failed in ${pkgRoot}; run it there by hand`);
    process.exit(r.status ?? 1);
  }
}
