#!/usr/bin/env node
/**
 * Mise-like task runner for personal-memory (reads ~/.config/personal-memory/config.toml).
 *   ./pm configure | up | down | doctor
 * Packaged installs reach it through `personal-memory <task>`.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ensureWizardDeps, resolveWizardRoots } from "../../cli/roots.mjs";

const { pkgRoot, repo: REPO, packaged } = resolveWizardRoots(import.meta.url);
// setup.mjs is code, so it always comes from the package root, never the stack root.
const SETUP = path.join(pkgRoot, "wizard/bin/setup.mjs");

const TASKS = {
  configure: { args: ["--yes"], help: "Full setup and start" },
  up: { args: ["--up", "--yes"], help: "Start stack" },
  down: { args: ["--down", "--yes"], help: "Stop stack" },
  doctor: { args: ["--yes", "--no-smoke"], help: "Validate config (no smoke)" },
  "install-mcp": {
    script: "cli/install-memory-mcp.mjs",
    help: "Install memory MCP servers into ~/.cursor/mcp.json",
  },
  "install-coding-agent": {
    script: "cli/install-coding-agent.mjs",
    help: "Wire session memory for Claude Code, Codex, OpenCode, Cursor CLI",
  },
  switch: {
    script: "cli/switch-memory-provider.mjs",
    help: "Switch MEMORY_PROVIDER (wizard.conf + optional stack/MCP)",
  },
};

const task = process.argv[2];
if (!task || task === "-h" || task === "--help") {
  ensureWizardDeps(pkgRoot, packaged);
  const { loadPmConfig } = await import("../lib/pm-config.mjs");
  const home = process.env.HOME || "";
  const { merged } = loadPmConfig(home, REPO);
  const tasks = /** @type {Record<string, {description?: string}>} */ (
    merged.tasks || {}
  );
  console.log("Usage: pm <task>\n");
  console.log("Tasks:");
  for (const name of Object.keys(TASKS)) {
    const desc = tasks[name]?.description || TASKS[name].help;
    console.log(`  ${name.padEnd(12)} ${desc}`);
  }
  process.exit(task ? 0 : 1);
}

const spec = TASKS[task];
if (!spec) {
  console.error(`unknown task: ${task} (try: ${Object.keys(TASKS).join(", ")})`);
  process.exit(1);
}

const extra = process.argv.slice(3);

if (spec.script) {
  const script = path.join(pkgRoot, spec.script);
  if (!fs.existsSync(script)) {
    console.error(`${spec.script} not found; run from a personal-memory checkout or install`);
    process.exit(1);
  }
  const r = spawnSync(process.execPath, [script, ...extra], {
    cwd: REPO,
    stdio: "inherit",
    env: process.env,
  });
  process.exit(r.status ?? 1);
}

if (!fs.existsSync(SETUP)) {
  console.error("setup.mjs not found; run from a personal-memory checkout or install");
  process.exit(1);
}

const r = spawnSync(process.execPath, [SETUP, ...spec.args, ...extra], {
  cwd: REPO,
  stdio: "inherit",
  env: process.env,
});
if (task === "doctor" && (r.status ?? 1) === 0) {
  const wiring = spawnSync(process.execPath, [path.join(pkgRoot, "cli/wiring-report.mjs")], {
    cwd: REPO,
    stdio: "inherit",
    env: process.env,
  });
  process.exit(wiring.status ?? 0);
}
process.exit(r.status ?? 1);
