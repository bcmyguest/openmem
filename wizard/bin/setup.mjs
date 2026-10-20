#!/usr/bin/env node
/**
 * Setup wizard entry (./setup in a checkout; `personal-memory setup` when packaged).
 *
 * REPO is the mutable stack root (PM_STACK_ROOT, default: the checkout): compose project
 * dir, .env, generated files and docker build context. PM_PACKAGE_ROOT is the read-only
 * code root (providers/, scripts/setup.mjs, wizard/lib).
 */
import { ensureWizardDeps, resolveWizardRoots } from "../../cli/roots.mjs";

const { pkgRoot, repo: REPO, packaged } = resolveWizardRoots(import.meta.url);
ensureWizardDeps(pkgRoot, packaged);

const { runWizard } = await import("../lib/run-wizard.mjs");

const argv = process.argv.slice(2);
const wantsClack =
  !argv.includes("--yes") &&
  !argv.includes("-y") &&
  !argv.includes("--dry-run") &&
  process.stdin.isTTY;

/** @type {Record<string, string>} */
let handoff = {};
if (wantsClack) {
  const { runClackSetup } = await import("../lib/run-clack.mjs");
  handoff = await runClackSetup(REPO);
  for (const [k, v] of Object.entries(handoff)) {
    process.env[k] = v;
  }
}

await runWizard(REPO, argv);
