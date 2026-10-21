#!/usr/bin/env node
/**
 * Install or print coding-agent wiring for Claude Code, Codex, OpenCode, Cursor CLI.
 * Hindsight: delegates to @vectorize-io/hindsight-coding-agents.
 * Other providers: unified MCP session path (see docs/coding-agent-hooks.md).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CODING_AGENTS, DEFAULT_AGENT_IDS } from "./coding-agent/agents.mjs";
import { AGENT_IDS, PROVIDER_CAPABILITIES } from "./coding-agent/capabilities.mjs";
import { resolveMemoryProvider } from "./install-memory-mcp.mjs";
import { resolveHindsightApiUrl } from "./mcp/context.mjs";
import { resolveStackRoot } from "./stack.mjs";
import { installSessionShim } from "./coding-agent/install-shim.mjs";
import { SHIM_AGENT_IDS } from "./coding-agent/hook-harnesses.mjs";
import { runInstallMemoryMcp } from "./install-memory-mcp.mjs";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = "personal-memory-install-coding-agent";

const HELP = `${BIN}: wire session memory for coding agents

Usage:
  npx personal-memory install-coding-agent [--yes] [--dry-run] [--agents a,b]

Default agents (Hindsight plugin): ${DEFAULT_AGENT_IDS.join(", ")}
All known agents: ${CODING_AGENTS.map((a) => a.id).join(", ")}

Hindsight runs hindsight-coding-agents install. mem0/Cognee install unified MCP plus in-repo session hooks (retain/recall/stop).
`;

function parseArgs(argv) {
  const flags = { yes: false, dry: false, help: false, agents: [...DEFAULT_AGENT_IDS], unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes" || a === "-y") flags.yes = true;
    else if (a === "--dry-run") flags.dry = true;
    else if (a === "--help" || a === "-h") flags.help = true;
    else if (a === "--agents") flags.agents = String(argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    else flags.unknown.push(a);
  }
  return flags;
}

function h() {
  return {
    info: (m) => console.log(m),
    ok: (m) => console.log(m),
    warn: (m) => console.warn(m),
  };
}

export async function runInstallCodingAgent(opts) {
  const home = opts.home;
  const env = opts.env || process.env;
  const flags = opts.flags;
  for (const agentId of flags.agents) {
    if (!AGENT_IDS.includes(agentId)) {
      opts.h?.warn(`Unknown agent "${agentId}" (known: ${AGENT_IDS.join(", ")})`);
    }
  }
  const provider = resolveMemoryProvider(home, env);
  const caps = PROVIDER_CAPABILITIES[provider] || {};
  if (provider === "hindsight") {
    const sr = opts.stackRoot;
    const apiUrl = resolveHindsightApiUrl({ home, stackRoot: sr, env });
    const agents = flags.agents.join(" ");
    const cmd = ["npx", "-y", "@vectorize-io/hindsight-coding-agents", "install", ...flags.agents, "--server", "self-hosted", "--api-url", apiUrl];
    if (flags.dry) {
      opts.h?.info(`dry-run: would run: ${cmd.join(" ")}`);
      return { provider, ran: false };
    }
    if (!flags.yes) {
      opts.h?.warn("Re-run with --yes to execute hindsight-coding-agents install");
      return { provider, ran: false };
    }
    const r = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit", env });
    return { provider, ran: true, status: r.status ?? 1 };
  }
  opts.h?.info(`Provider ${provider}: session hooks use unified MCP (memory_*). Capabilities: ${JSON.stringify(caps)}`);
  opts.h?.info("Run: npx personal-memory install-mcp --yes");
  const shimAgents = flags.agents.filter((id) => SHIM_AGENT_IDS.includes(id) || id === "opencode");
  if (!flags.dry && flags.yes) {
    await runInstallMemoryMcp({
      home,
      repoRoot: opts.repoRoot,
      stackRoot: opts.stackRoot,
      flags: { yes: true, dry: false, notebooklm: false, notebooklmOnly: false, providerOnly: false, noUnifiedMcp: false, help: false, unknown: [] },
      env,
      h: opts.h || h(),
    });
    installSessionShim({
      home,
      repoRoot: opts.repoRoot,
      agents: shimAgents,
      dry: false,
      h: opts.h || h(),
    });
  } else if (flags.dry) {
    installSessionShim({
      home,
      repoRoot: opts.repoRoot,
      agents: shimAgents,
      dry: true,
      h: opts.h || h(),
    });
  }
  for (const agentId of flags.agents) {
    const row = CODING_AGENTS.find((a) => a.id === agentId);
    if (shimAgents.includes(agentId)) {
      opts.h?.info(`  ${agentId}: personal-memory session hooks (SessionStart / prompt / Stop)`);
    } else {
      opts.h?.info(`  ${agentId}: ${row?.sessionPath || "use personal-memory MCP memory_* after install-mcp"}`);
    }
  }
  return { provider, ran: !flags.dry && flags.yes };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help || flags.unknown.length) {
    console.log(HELP);
    process.exit(flags.unknown.length ? 2 : 0);
  }
  const home = process.env.HOME || "";
  const sr = resolveStackRoot({ pkgRoot: PKG_ROOT });
  const out = await runInstallCodingAgent({
    home,
    repoRoot: PKG_ROOT,
    stackRoot: sr.root,
    flags,
    env: process.env,
    h: h(),
  });
  process.exit(typeof out.status === "number" ? out.status : 0);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
