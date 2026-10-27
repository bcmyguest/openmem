#!/usr/bin/env node
/**
 * Switch the active memory provider (wizard.conf + optional stack restart + MCP).
 *
 *   npx openmem switch <hindsight|mem0|cognee> [--yes] [--dry-run] [--no-stack] [--no-mcp]
 *   openmem-switch-provider …
 *   npx . switch <id> … / ./pm switch <id> …
 *
 * Does not migrate data between providers. No secrets in logs.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";
import { resolveMemoryProvider } from "./install-memory-mcp.mjs";
import { resolveStackRoot } from "./stack.mjs";
import { envValue } from "../wizard/lib/paths.mjs";
import { updatePmConfigProvider, userConfigPath } from "../wizard/lib/pm-config.mjs";
import { listSelectableProviders, loadManifest } from "../wizard/lib/providers/registry.mjs";
import { upsertWizardConf } from "../wizard/lib/wizard-conf.mjs";
import { resolveMem0EnvFilePath, resolveMem0ApiUrl } from "../providers/mem0/lib/mcp-install.mjs";
import { envFileProblem } from "../providers/mem0/lib/state.mjs";
import { urlProblem } from "../providers/mem0/lib/url.mjs";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = "openmem-switch-provider";

const HELP = `${BIN}: switch the active memory provider

Usage:
  ${BIN} <provider> [flags]
  npm run switch-provider -- <provider> [flags]
  ./pm switch <provider> [flags]

Providers (selectable): hindsight, mem0, cognee (see providers/*/manifest.json).

Flags:
  --yes               no confirmation prompts
  --dry-run           print actions; write nothing / skip stack+MCP side effects
  --no-stack          skip compose down/up for the new provider
  --no-mcp            skip install-mcp --provider-only
  -h, --help          this help

Current provider: MEMORY_PROVIDER, else ~/.config/hindsight/wizard.conf, else hindsight.
No automatic data migration between providers.
`;

/**
 * @typedef {{
 *   yes: boolean,
 *   dry: boolean,
 *   noStack: boolean,
 *   noMcp: boolean,
 *   help: boolean,
 *   provider: string,
 *   unknown: string[],
 * }} SwitchProviderFlags
 */

/**
 * @param {string[]} argv
 * @returns {SwitchProviderFlags}
 */
export function parseSwitchProviderArgs(argv) {
  /** @type {SwitchProviderFlags} */
  const flags = {
    yes: false,
    dry: false,
    noStack: false,
    noMcp: false,
    help: false,
    provider: "",
    unknown: [],
  };
  for (const arg of argv) {
    switch (arg) {
      case "--yes":
      case "-y":
        flags.yes = true;
        break;
      case "--dry-run":
        flags.dry = true;
        break;
      case "--no-stack":
        flags.noStack = true;
        break;
      case "--no-mcp":
        flags.noMcp = true;
        break;
      case "-h":
      case "--help":
        flags.help = true;
        break;
      default:
        if (arg.startsWith("-")) flags.unknown.push(arg);
        else if (!flags.provider) flags.provider = arg;
        else flags.unknown.push(arg);
        break;
    }
  }
  return flags;
}

/** @returns {string[]} */
export function selectableProviderIds() {
  return listSelectableProviders().map((m) => m.id);
}

export { updatePmConfigProvider };

/**
 * mem0 must have a usable API URL (and a valid env-file path). Never logs secrets.
 * @param {{ home: string, stackRoot: string, env?: NodeJS.ProcessEnv }} opts
 */
export function ensureMem0SwitchReady(opts) {
  const env = opts.env || process.env;
  const apiUrl = resolveMem0ApiUrl({ home: opts.home, stackRoot: opts.stackRoot, env });
  const issue = urlProblem(apiUrl);
  if (issue) {
    throw new Error(`mem0 API URL: ${issue} — see providers/mem0/OPERATOR.md`);
  }
  const envFile = resolveMem0EnvFilePath({ home: opts.home, stackRoot: opts.stackRoot, env });
  const fileIssue = envFileProblem(envFile);
  if (fileIssue) {
    throw new Error(`mem0 env file: ${fileIssue} — see providers/mem0/OPERATOR.md`);
  }
}

/**
 * Cognee needs a sensible COGNEE_PORT (env / stack .env / wizard.conf / default 8766).
 * @param {{ home: string, stackRoot: string, env?: NodeJS.ProcessEnv }} opts
 */
export function ensureCogneeSwitchReady(opts) {
  const env = opts.env || process.env;
  const stackEnv = path.join(opts.stackRoot, ".env");
  const wizardConf = path.join(opts.home, ".config/hindsight/wizard.conf");
  const candidates = [
    env.COGNEE_PORT,
    envValue(stackEnv, "COGNEE_PORT"),
    envValue(wizardConf, "COGNEE_PORT"),
    "8766",
  ];
  const port = candidates.map((v) => String(v || "").trim()).find(Boolean) || "";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error(
      `COGNEE_PORT must be 1–65535 (got ${JSON.stringify(port)}) — see providers/cognee/OPERATOR.md`,
    );
  }
}

/** @param {{ info: Function, ok: Function, warn: Function }} h */
function makeLogger() {
  return {
    info: (/** @type {string} */ m) => console.log(`  ${m}`),
    ok: (/** @type {string} */ m) => console.log(`✓ ${m}`),
    warn: (/** @type {string} */ m) => console.warn(`! ${m}`),
  };
}

/**
 * @param {string} question
 * @returns {Promise<boolean>}
 */
function confirmProceed(question) {
  if (!process.stdin.isTTY) return Promise.resolve(true);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} [Y/n] `, (answer) => {
      rl.close();
      const a = String(answer || "").trim().toLowerCase();
      resolve(a === "" || a === "y" || a === "yes");
    });
  });
}

/**
 * @param {string} script relative to pkgRoot
 * @param {string[]} args
 * @param {{ pkgRoot: string, stackRoot: string, env: NodeJS.ProcessEnv, dry: boolean, h: any, label: string }} opts
 */
function spawnNodeScript(script, args, opts) {
  const { pkgRoot, stackRoot, env, dry, h, label } = opts;
  const abs = path.join(pkgRoot, script);
  if (dry) {
    h.info(`[dry-run] ${label}: node ${script} ${args.join(" ")}`);
    return;
  }
  const r = spawnSync(process.execPath, [abs, ...args], {
    cwd: stackRoot,
    stdio: "inherit",
    env,
  });
  if (r.error) throw new Error(`${label}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${label} exited ${r.status ?? "null"}`);
}

/**
 * @param {{
 *   home: string,
 *   repoRoot: string,
 *   stackRoot: string,
 *   flags: SwitchProviderFlags,
 *   env?: NodeJS.ProcessEnv,
 *   h?: { info: Function, ok: Function, warn: Function },
 *   confirm?: (q: string) => Promise<boolean>,
 * }} opts
 */
export async function runSwitchMemoryProvider(opts) {
  const home = opts.home;
  const stackRoot = opts.stackRoot;
  const repoRoot = opts.repoRoot;
  const flags = opts.flags;
  const env = opts.env || process.env;
  const h = opts.h || makeLogger();
  const ask = opts.confirm || confirmProceed;

  const target = String(flags.provider || "").trim();
  if (!target) {
    throw new Error(`provider id required\n\n${HELP}`);
  }

  const selectable = selectableProviderIds();
  if (!selectable.includes(target)) {
    throw new Error(
      `unknown or non-selectable provider "${target}" (want one of: ${selectable.join(", ")})`,
    );
  }

  const current = resolveMemoryProvider(home, env);
  h.info(`current=${current} → target=${target}`);

  if (current === target) {
    h.ok(`provider "${target}" is already active`);
    return { current, target, same: true, aborted: false };
  }

  h.warn("Switching providers does not migrate memories or banks between backends.");

  if (!flags.yes && !flags.dry) {
    const ok = await ask(`Switch memory provider from ${current} to ${target}?`);
    if (!ok) {
      h.warn("aborted");
      return { current, target, same: false, aborted: true };
    }
  }

  const wizardConf = path.join(home, ".config/hindsight/wizard.conf");
  const hsDir = path.join(home, ".config/hindsight");
  const manifest = loadManifest(target);
  const ctx = {
    home,
    hsDir,
    wizardConf,
    dry: flags.dry,
    memoryProvider: manifest || { id: target },
  };

  if (flags.dry) {
    h.info(`[dry-run] upsert MEMORY_PROVIDER=${target} in ${wizardConf}`);
  } else {
    upsertWizardConf(ctx, {});
    h.ok(`MEMORY_PROVIDER=${target} in ${wizardConf}`);
  }

  const pmResult = updatePmConfigProvider(home, target, { dry: flags.dry });
  if (pmResult === "updated") h.ok(`memory.provider=${target} in ${userConfigPath(home)}`);
  else if (pmResult === "dry-run") h.info(`[dry-run] would update memory.provider in ${userConfigPath(home)}`);
  else h.info(`${userConfigPath(home)} absent — skipped`);

  const childEnv = {
    ...env,
    MEMORY_PROVIDER: target,
    PM_STACK_ROOT: stackRoot,
    PM_PACKAGE_ROOT: repoRoot,
  };

  if (!flags.noStack) {
    if (target === "mem0") {
      ensureMem0SwitchReady({ home, stackRoot, env: childEnv });
      h.ok("mem0 URL/env-file path look usable");
    } else if (target === "cognee") {
      ensureCogneeSwitchReady({ home, stackRoot, env: childEnv });
      h.ok("cognee port looks usable");
    }

    spawnNodeScript(
      "wizard/bin/setup.mjs",
      ["--down", "--yes"],
      { pkgRoot: repoRoot, stackRoot, env: childEnv, dry: flags.dry, h, label: "setup --down" },
    );
    spawnNodeScript(
      "wizard/bin/setup.mjs",
      ["--up", "--yes"],
      { pkgRoot: repoRoot, stackRoot, env: childEnv, dry: flags.dry, h, label: "setup --up" },
    );
    if (!flags.dry) h.ok(`stack restarted for provider=${target}`);
  } else {
    h.info("skipped stack restart (--no-stack)");
  }

  if (!flags.noMcp) {
    const mcpArgs = ["--yes", "--provider-only"];
    if (flags.dry) mcpArgs.push("--dry-run");
    spawnNodeScript("cli/install-memory-mcp.mjs", mcpArgs, {
      pkgRoot: repoRoot,
      stackRoot,
      env: childEnv,
      dry: false, // dry-run is passed through to install-mcp
      h,
      label: "install-mcp --provider-only",
    });
  } else {
    h.info("skipped MCP install (--no-mcp)");
  }

  h.ok("Restart Cursor Agent so it picks up the new provider / MCP wiring");
  h.info("Then run: ./pm doctor");

  return { current, target, same: false, aborted: false };
}

async function main(argv) {
  const flags = parseSwitchProviderArgs(argv);
  if (flags.help) {
    console.log(HELP);
    process.exit(0);
  }
  if (flags.unknown.length) {
    console.error(`${BIN}: unknown option(s): ${flags.unknown.join(", ")}`);
    console.error(HELP);
    process.exit(2);
  }
  if (!flags.provider) {
    console.error(`${BIN}: provider id required`);
    console.error(HELP);
    process.exit(2);
  }

  const home = process.env.HOME || os.homedir();
  const stack = resolveStackRoot({ pkgRoot: PKG_ROOT, env: process.env, home });
  const repoRoot = PKG_ROOT;
  const stackRoot = stack.root;

  try {
    const result = await runSwitchMemoryProvider({ home, repoRoot, stackRoot, flags });
    if (result.aborted) process.exit(1);
  } catch (err) {
    console.error(`${BIN}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2));
}
