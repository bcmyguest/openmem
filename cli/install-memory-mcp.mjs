#!/usr/bin/env node
/**
 * Install memory-related MCP servers into ~/.cursor/mcp.json only.
 *
 *   personal-memory-install-mcp [--yes] [--dry-run] [--notebooklm] [--notebooklm-only] [--provider-only]
 *   npm run install-mcp -- …
 *
 * Provider: MEMORY_PROVIDER → ~/.config/hindsight/wizard.conf → hindsight.
 * NotebookLM MCP: notebooklm.yml enabled:true and/or --notebooklm (unless --provider-only).
 * Never writes machine paths into the shipped config/coding-agent.json template.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { setNotebooklmAccessEnabled } from "../wizard/lib/notebooklm-agent-access.mjs";
import { envValue } from "../wizard/lib/paths.mjs";
import { installNotebooklmMcp } from "../providers/hindsight/lib/notebooklm-mcp-install.mjs";
import {
  cogneeMcpEntry,
  installCogneeMcp as installCogneeMcpFromProvider,
  resolveCogneeApiUrl,
} from "../providers/cognee/lib/cognee-mcp-install.mjs";
import {
  installMem0Mcp as installMem0McpFromProvider,
  mem0McpEntry,
  mem0McpScriptPath,
  mergeMem0McpServer,
  resolveMem0ApiUrl,
} from "../providers/mem0/lib/mcp-install.mjs";
import { resolveStackRoot } from "./stack.mjs";

export { mem0McpEntry, mergeMem0McpServer, resolveMem0ApiUrl };

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = "personal-memory-install-mcp";
const DEFAULT_PROVIDER = "hindsight";
/** Sibling MCP servers this tool must never rewrite (merge targets mem0/cognee stay off this list). */
export const PROTECTED_MCP_SERVERS = Object.freeze(["hindsight", "codegraph", "notebooklm"]);

const HELP = `${BIN}: merge memory MCP servers into ~/.cursor/mcp.json

Usage:
  ${BIN} [flags]
  npx personal-memory install-mcp [flags]
  npm run install-mcp -- [flags]             # checkout

Flags:
  --yes               no confirmation prompts
  --dry-run           print actions; write nothing
  --notebooklm        force NotebookLM MCP + notebooklmAccess.enabled
  --notebooklm-only   only NotebookLM step (skip provider MCP)
  --provider-only     only provider MCP (skip NotebookLM)
  -h, --help          this help

Provider resolution: MEMORY_PROVIDER, else wizard.conf, else hindsight.
NotebookLM is also detected when ~/.config/hindsight/notebooklm.yml has enabled: true.
`;

/**
 * @typedef {{
 *   yes: boolean,
 *   dry: boolean,
 *   notebooklm: boolean,
 *   notebooklmOnly: boolean,
 *   providerOnly: boolean,
 *   help: boolean,
 *   unknown: string[],
 * }} InstallMcpFlags
 */

/**
 * @param {string[]} argv
 * @returns {InstallMcpFlags}
 */
export function parseInstallMcpArgs(argv) {
  /** @type {InstallMcpFlags} */
  const flags = {
    yes: false,
    dry: false,
    notebooklm: false,
    notebooklmOnly: false,
    providerOnly: false,
    help: false,
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
      case "--notebooklm":
        flags.notebooklm = true;
        break;
      case "--notebooklm-only":
        flags.notebooklmOnly = true;
        break;
      case "--provider-only":
        flags.providerOnly = true;
        break;
      case "-h":
      case "--help":
        flags.help = true;
        break;
      default:
        flags.unknown.push(arg);
        break;
    }
  }
  return flags;
}

/**
 * @param {string} home
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveMemoryProvider(home, env = process.env) {
  const fromEnv = String(env.MEMORY_PROVIDER || "").trim();
  if (fromEnv) return fromEnv;
  const conf = path.join(home, ".config/hindsight/wizard.conf");
  const fromConf = envValue(conf, "MEMORY_PROVIDER").trim();
  if (fromConf) return fromConf;
  return DEFAULT_PROVIDER;
}

/**
 * True when notebooklm.yml has a top-level `enabled: true` (same regex as the wizard).
 * @param {string} notebookFile
 */
export function notebooklmEnabledInYml(notebookFile) {
  if (!fs.existsSync(notebookFile)) return false;
  try {
    return /^enabled:\s*true\b/m.test(fs.readFileSync(notebookFile, "utf8"));
  } catch {
    return false;
  }
}

/**
 * @param {{ home: string, flags: InstallMcpFlags }} opts
 */
export function shouldInstallNotebooklm({ home, flags }) {
  if (flags.providerOnly) return false;
  if (flags.notebooklm || flags.notebooklmOnly) return true;
  return notebooklmEnabledInYml(path.join(home, ".config/hindsight/notebooklm.yml"));
}

/**
 * Merge one named MCP server; refuse to mutate protected sibling keys.
 * @param {Record<string, any>} mcp
 * @param {string} name
 * @param {Record<string, any>} entry
 * @param {{ protect?: string[] }} [opts]
 * @returns {{ mcp: Record<string, any>, changed: boolean, skipped?: string, refused?: string }}
 */
export function mergeNamedMcpServer(mcp, name, entry, opts = {}) {
  const protect = opts.protect || PROTECTED_MCP_SERVERS;
  if (protect.includes(name) && name !== "notebooklm") {
    // notebooklm is updated only via mergeNotebooklmMcpServer / installNotebooklmMcp.
    return { mcp, changed: false, refused: `refusing to merge protected MCP name "${name}"` };
  }
  const out = { ...mcp };
  const servers = { ...(mcp.mcpServers && typeof mcp.mcpServers === "object" ? mcp.mcpServers : {}) };
  const before = Object.fromEntries(protect.map((k) => [k, servers[k]]));
  const prev = servers[name];
  const same = prev && JSON.stringify(prev) === JSON.stringify(entry);
  if (same) {
    return { mcp: { ...out, mcpServers: servers }, changed: false, skipped: "already configured" };
  }
  servers[name] = entry;
  for (const k of protect) {
    if (k === name) continue;
    if (before[k] !== undefined && servers[k] !== before[k]) {
      return { mcp, changed: false, refused: `refusing to alter ${k} MCP entry` };
    }
  }
  return { mcp: { ...out, mcpServers: servers }, changed: true };
}

/**
 * Back-compat alias: real mem0 MCP entry (node launcher → npx @yeyuan98/mem0-mcp).
 * Prefer mem0McpEntry({ apiUrl, scriptPath, envFile }) for new code.
 * @param {string} apiUrl
 */
export function mem0McpPlaceholderEntry(apiUrl) {
  return mem0McpEntry({
    apiUrl,
    scriptPath: mem0McpScriptPath(PKG_ROOT),
  });
}

/**
 * Cognee stdio MCP entry (node + script + COGNEE_API_URL). No API key.
 * @param {string} scriptPath absolute path
 * @param {string} [apiUrl]
 */
export function cogneeMcpStubEntry(scriptPath, apiUrl) {
  return cogneeMcpEntry(scriptPath, apiUrl);
}

/**
 * @param {string} mcpPath
 * @returns {Record<string, any>}
 */
export function readMcpJson(mcpPath) {
  if (!fs.existsSync(mcpPath)) return {};
  return JSON.parse(fs.readFileSync(mcpPath, "utf8"));
}

/**
 * @param {string} mcpPath
 * @param {Record<string, any>} mcp
 * @param {{ dry?: boolean }} [opts]
 */
export function writeMcpJson(mcpPath, mcp, opts = {}) {
  if (opts.dry) return;
  fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
  fs.writeFileSync(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);
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
 * @param {{
 *   home: string,
 *   repoRoot: string,
 *   stackRoot: string,
 *   flags: InstallMcpFlags,
 *   env?: NodeJS.ProcessEnv,
 *   h?: { info: Function, ok: Function, warn: Function },
 *   confirm?: (q: string) => Promise<boolean>,
 * }} opts
 */
export async function runInstallMemoryMcp(opts) {
  const home = opts.home;
  const repoRoot = opts.repoRoot;
  const stackRoot = opts.stackRoot;
  const flags = opts.flags;
  const env = opts.env || process.env;
  const h = opts.h || makeLogger();
  const ask = opts.confirm || confirmProceed;

  if (flags.notebooklmOnly && flags.providerOnly) {
    throw new Error("--notebooklm-only and --provider-only are mutually exclusive");
  }

  const provider = resolveMemoryProvider(home, env);
  const doNotebooklm = shouldInstallNotebooklm({ home, flags });
  const doProvider = !flags.notebooklmOnly;

  const plan = [];
  if (doNotebooklm) plan.push("notebooklmAccess + notebooklm MCP");
  if (doProvider) {
    if (provider === "mem0") plan.push("mem0 MCP (@yeyuan98/mem0-mcp via cli/mem0-mcp.mjs)");
    else if (provider === "cognee") plan.push("cognee MCP (read-only health/search)");
    else if (provider === "hindsight") plan.push("hindsight note (coding-agents plugin separate)");
    else plan.push(`provider=${provider} (no MCP handler)`);
  }

  h.info(`provider=${provider}`);
  h.info(`plan: ${plan.length ? plan.join("; ") : "(nothing)"}`);

  if (!plan.length) {
    h.info("nothing to install");
    return { provider, didNotebooklm: false, didProvider: false };
  }

  if (!flags.yes && !flags.dry) {
    const ok = await ask(`Apply MCP changes to ${path.join(home, ".cursor/mcp.json")}?`);
    if (!ok) {
      h.warn("aborted");
      return { provider, didNotebooklm: false, didProvider: false, aborted: true };
    }
  }

  let didNotebooklm = false;
  if (doNotebooklm) {
    const agentPath = path.join(home, ".hindsight", "coding-agent.json");
    const templatePath = path.join(repoRoot, "config/coding-agent.json");
    if (flags.dry) {
      const planAccess = setNotebooklmAccessEnabled(agentPath, templatePath, true, { dry: true });
      h.info(
        `[dry-run] ${planAccess.action} ${agentPath} with notebooklmAccess.enabled=true; merge notebooklm MCP into ~/.cursor/mcp.json`,
      );
    } else {
      const result = setNotebooklmAccessEnabled(agentPath, templatePath, true);
      h.ok(
        `notebooklmAccess.enabled=true in ${agentPath}` +
          (result.action === "materialized" ? " (copied from symlink → regular file)" : ""),
      );
      await installNotebooklmMcp({ home, repoRoot, agentJson: agentPath, dry: false }, h);
    }
    didNotebooklm = true;
  }

  let didProvider = false;
  if (doProvider) {
    if (provider === "hindsight") {
      h.info(
        "hindsight coding-agents plugin is separate: run `personal-memory setup` / `npx @vectorize-io/hindsight-coding-agents install …`",
      );
      didProvider = true;
    } else if (provider === "mem0") {
      await installMem0ProviderMcp({ home, repoRoot, stackRoot, flags, env, h });
      didProvider = true;
    } else if (provider === "cognee") {
      await installCogneeMcp({ home, repoRoot, stackRoot, flags, env, h });
      didProvider = true;
    } else {
      h.warn(`no MCP install handler for provider "${provider}"`);
    }
  }

  if (!flags.dry && (didNotebooklm || (didProvider && provider !== "hindsight"))) {
    h.ok("Restart Cursor Agent so it picks up MCP changes");
  }

  return { provider, didNotebooklm, didProvider };
}

/**
 * @param {{ home: string, stackRoot: string, flags: InstallMcpFlags, env: NodeJS.ProcessEnv, h: any, repoRoot: string }} opts
 */
async function installMem0ProviderMcp({ home, stackRoot, flags, env, h, repoRoot }) {
  await installMem0McpFromProvider({ home, repoRoot, stackRoot, dry: flags.dry, env }, h);
}

/**
 * @param {{
 *   home: string,
 *   repoRoot: string,
 *   stackRoot: string,
 *   flags: InstallMcpFlags,
 *   env: NodeJS.ProcessEnv,
 *   h: any,
 * }} opts
 */
async function installCogneeMcp({ home, repoRoot, stackRoot, flags, env, h }) {
  const apiUrl = resolveCogneeApiUrl({ home, stackRoot, repoRoot, env });
  await installCogneeMcpFromProvider(
    { home, repoRoot, dry: flags.dry, cogneeUrl: apiUrl },
    h,
  );
}

async function main(argv) {
  const flags = parseInstallMcpArgs(argv);
  if (flags.help) {
    console.log(HELP);
    process.exit(0);
  }
  if (flags.unknown.length) {
    console.error(`${BIN}: unknown option(s): ${flags.unknown.join(", ")}`);
    console.error(HELP);
    process.exit(2);
  }

  const home = process.env.HOME || os.homedir();
  const stack = resolveStackRoot({ pkgRoot: PKG_ROOT, env: process.env, home });
  // Code (MCP scripts, templates) comes from the package; .env lives in the stack root.
  const repoRoot = PKG_ROOT;
  const stackRoot = stack.root;

  try {
    await runInstallMemoryMcp({ home, repoRoot, stackRoot, flags });
  } catch (err) {
    console.error(`${BIN}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2));
}
