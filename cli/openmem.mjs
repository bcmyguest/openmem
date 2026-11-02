#!/usr/bin/env node
/**
 * openmem: npx entry point for the memory-stack setup wizard.
 *
 *   openmem [setup|configure|up|down|doctor|providers|init|context|--help|--version]
 *
 * The wizard code runs from this package (read-only, may be an npx cache). Everything it
 * writes, and the compose files it drives, live in a stable stack root; see cli/stack.mjs.
 * Real file, not a symlink: npm drops symlinks.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changedCount, formatReport, resolveStackRoot, syncStack } from "./stack.mjs";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8"));
// The only place the CLI learns the package name; the bin name is a command, not the package.
const BIN = "openmem";

/** Align a command column for help text (width fits the longest command + a space). */
function helpRow(cmd, desc, width = 30) {
  return `  ${cmd.padEnd(width)}${desc}`;
}

const HELP = `${BIN} ${pkg.version}
Self-hosted AI memory for coding agents (Docker Compose).

Usage:
  ${BIN} <command> [flags]
  npx @bcmyguest/openmem <command> [flags]

Setup:
${helpRow("setup [flags]", "Interactive wizard (--yes, --dry-run, …)")}
${helpRow("configure [flags]", "Non-interactive setup + start (= setup --yes)")}
${helpRow("init [--force] [--dry-run]", "Create/upgrade the stack root only")}

Stack:
${helpRow("up", "Start the saved stack")}
${helpRow("down", "Stop the stack")}
${helpRow("doctor", "Validate config (no smoke test)")}
${helpRow("wiring [--json]", "Provider, API URLs, MCP alignment")}
${helpRow("switch <provider>", "Change MEMORY_PROVIDER (no data migration)")}
${helpRow("providers [--json]", "List shipped providers")}

Agents:
${helpRow("install-mcp [flags]", "Register memory MCP in ~/.cursor/mcp.json")}
${helpRow("install-coding-agent [flags]", "MCP + session hooks (Claude/Codex/OpenCode/Cursor)")}
${helpRow("context on|off|status|stats", "Smart compaction (see: openmem context --help)")}

Feeds:
${helpRow("feed-sync", "Fetch RSS/OpenAlex into the feed cache")}
${helpRow("schedule install|remove", "Hourly feed sync via the OS scheduler")}

Also:
${helpRow("--help, -h", "Show this help")}
${helpRow("--version, -v", "Print version")}

Notes:
  Bare \`${BIN}\` prints this help. Wizard flags alone still work: \`${BIN} --yes\`
  Wizard flag details: \`${BIN} setup --help\`
  Stack root: $PM_STACK_ROOT, else ~/.local/share/personal-memory/stack
  Docs: docs/npx-install.md`;

const WIZARD_TASKS = new Set(["configure", "up", "down", "doctor", "install-mcp", "install-coding-agent", "switch"]);

/** @param {string} msg */
function die(msg, code = 1) {
  console.error(`${BIN}: ${msg}`);
  process.exit(code);
}

/**
 * Provider manifests shipped in the package.
 *
 * @returns {{ id: string, status: string, label: string, notes?: string }[]}
 */
function readProviders() {
  const dir = path.join(PKG_ROOT, "providers");
  /** @type {{ id: string, status: string, label: string, notes?: string }[]} */
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return out;
  }
  for (const id of names) {
    const file = path.join(dir, id, "manifest.json");
    if (!fs.existsSync(file)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(file, "utf8"));
      out.push({ id: m.id || id, status: m.status || "unknown", label: m.label || id, notes: m.notes });
    } catch {
      out.push({ id, status: "invalid", label: `unreadable ${file}` });
    }
  }
  return out;
}

/** @param {string[]} args */
function cmdProviders(args) {
  const list = readProviders();
  if (args.includes("--json")) {
    console.log(JSON.stringify(list, null, 2));
    return;
  }
  const w = Math.max(2, ...list.map((p) => p.id.length));
  console.log(`${"ID".padEnd(w)}  ${"STATUS".padEnd(12)}  LABEL`);
  for (const p of list) console.log(`${p.id.padEnd(w)}  ${p.status.padEnd(12)}  ${p.label}`);
  if (!list.length) console.log("(no provider manifests found)");
}

/**
 * Materialize the stack root (no-op for a checkout).
 *
 * @param {{ force?: boolean, dryRun?: boolean, quiet?: boolean, json?: boolean }} [opts]
 */
function ensureStack(opts = {}) {
  const sr = resolveStackRoot({ pkgRoot: PKG_ROOT });
  if (!sr.copy) return { sr, report: null };
  let report;
  try {
    report = syncStack({
      pkgRoot: PKG_ROOT,
      stackRoot: sr.root,
      name: pkg.name,
      version: pkg.version,
      force: opts.force,
      dryRun: opts.dryRun,
    });
  } catch (e) {
    die(`cannot prepare the stack root ${sr.root}: ${/** @type {Error} */ (e).message}`);
  }
  if (!opts.quiet && !opts.json && (changedCount(report) || report.conflicts.length)) {
    for (const line of formatReport(report)) console.error(line);
  }
  return { sr, report };
}

/** @param {string[]} args */
function cmdInit(args) {
  const force = args.includes("--force");
  const dryRun = args.includes("--dry-run");
  const json = args.includes("--json");
  for (const a of args) {
    if (!["--force", "--dry-run", "--json"].includes(a)) die(`init: unknown option ${a}`, 2);
  }
  const { sr, report } = ensureStack({ force, dryRun, json, quiet: true });
  if (json) {
    console.log(JSON.stringify({ stackRoot: sr.root, mode: sr.mode, source: sr.source, report }, null, 2));
    return;
  }
  if (!report) {
    console.log(`stack root: ${sr.root} (${sr.source}; used in place, nothing copied)`);
    return;
  }
  for (const line of formatReport(report)) console.log(line);
}

/**
 * Run a wizard script from the package against the stack root.
 *
 * @param {string} script path relative to the package root
 * @param {string[]} args
 * @param {string} stackRoot
 */
function runWizardScript(script, args, stackRoot) {
  const r = spawnSync(process.execPath, [path.join(PKG_ROOT, script), ...args], {
    cwd: stackRoot,
    stdio: "inherit",
    env: { ...process.env, PM_STACK_ROOT: stackRoot, PM_PACKAGE_ROOT: PKG_ROOT },
  });
  if (r.error) die(`failed to start the wizard: ${r.error.message}`);
  if (r.signal) process.kill(process.pid, r.signal);
  process.exit(r.status ?? 1);
}

const argv = process.argv.slice(2);
const cmd = argv[0];

if (cmd === "--version" || cmd === "-v" || cmd === "version") {
  console.log(pkg.version);
} else if (cmd === "--help" || cmd === "-h" || cmd === "help") {
  console.log(HELP);
} else if (cmd === "providers") {
  cmdProviders(argv.slice(1));
} else if (cmd === "init") {
  cmdInit(argv.slice(1));
} else if (cmd === "feed-sync") {
  const r = spawnSync(process.execPath, [path.join(PKG_ROOT, "cli/feed-sync.mjs"), ...argv.slice(1)], {
    stdio: "inherit",
    env: process.env,
  });
  process.exit(r.status ?? 1);
} else if (cmd === "schedule") {
  const r = spawnSync(process.execPath, [path.join(PKG_ROOT, "cli/schedule.mjs"), ...argv.slice(1)], {
    stdio: "inherit",
    env: process.env,
  });
  process.exit(r.status ?? 1);
} else if (cmd === "context") {
  // on/off run compose from the stack root, so materialize it first.
  const { sr } = ensureStack({ quiet: true });
  const r = spawnSync(process.execPath, [path.join(PKG_ROOT, "cli/context-management.mjs"), ...argv.slice(1)], {
    stdio: "inherit",
    env: { ...process.env, PM_STACK_ROOT: sr.root },
  });
  process.exit(r.status ?? 1);
} else if (cmd === "wiring") {
  const r = spawnSync(process.execPath, [path.join(PKG_ROOT, "cli/wiring-report.mjs"), ...argv.slice(1)], {
    stdio: "inherit",
    env: process.env,
  });
  process.exit(r.status ?? 1);
} else if (cmd === undefined) {
  console.log(HELP);
} else if (cmd === "setup" || cmd.startsWith("-")) {
  const args = cmd === "setup" ? argv.slice(1) : argv;
  // Wizard help does not need a stack root.
  if (args.includes("--help") || args.includes("-h")) {
    const sr = resolveStackRoot({ pkgRoot: PKG_ROOT });
    runWizardScript("wizard/bin/setup.mjs", args, fs.existsSync(sr.root) ? sr.root : PKG_ROOT);
  } else {
    const { sr } = ensureStack();
    runWizardScript("wizard/bin/setup.mjs", args, sr.root);
  }
} else if (WIZARD_TASKS.has(cmd)) {
  const { sr } = ensureStack();
  runWizardScript("wizard/bin/pm.mjs", argv, sr.root);
} else {
  console.error(`${BIN}: unknown command: ${cmd}\n`);
  console.error(HELP);
  process.exit(2);
}
