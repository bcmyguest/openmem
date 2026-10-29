#!/usr/bin/env node
/**
 * Install coding-agent session memory for Claude Code, Codex, OpenCode, Cursor CLI.
 * All providers: unified MCP. Session hooks come from OpenMem ([agents] integration =
 * "openmem", default) or the provider's own plugin ("provider", Hindsight only); never both.
 * Optional: rtk command rewriting when rtk is on PATH, and the local context proxy.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CODING_AGENTS, DEFAULT_AGENT_IDS } from "./coding-agent/agents.mjs";
import { AGENT_IDS, PROVIDER_CAPABILITIES } from "./coding-agent/capabilities.mjs";
import { installSessionShim, removeSessionShim, removeUpstreamHooks } from "./coding-agent/install-shim.mjs";
import { installAgentAccess } from "./coding-agent/install-access.mjs";
import { installContextProxy } from "./coding-agent/install-context-proxy.mjs";
import { installRtk } from "./coding-agent/install-rtk.mjs";
import { prepareAgentRuntime } from "./coding-agent/runtime.mjs";
import { SHIM_AGENT_IDS } from "./coding-agent/hook-harnesses.mjs";
import { resolveMemoryProvider } from "./install-memory-mcp.mjs";
import { isMainModule } from "./is-main.mjs";
import { resolveHindsightApiUrl } from "./mcp/context.mjs";
import { resolveStackRoot } from "./stack.mjs";
import { runInstallMemoryMcp } from "./install-memory-mcp.mjs";
import {
  agentIntegrationFromPmConfig,
  contextProxyFromPmConfig,
  loadPmConfig,
  updatePmConfigTable,
} from "../wizard/lib/pm-config.mjs";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = "openmem-install-coding-agent";
/** Providers that ship their own coding-agent plugin. */
const PROVIDER_PLUGINS = ["hindsight"];

const HELP = `${BIN}: wire session memory for coding agents

Usage:
  npx openmem install-coding-agent [--yes] [--dry-run] [--agents a,b]
      [--provider-plugin | --no-provider-plugin] [--no-rtk]
      [--context-proxy | --no-context-proxy]

Default agents: ${DEFAULT_AGENT_IDS.join(", ")}
All known agents: ${CODING_AGENTS.map((a) => a.id).join(", ")}

Every provider gets install-mcp. Session hooks are exclusive:
  default             openmem hooks (SessionStart / prompt / Stop); removes upstream Hindsight hooks
  --provider-plugin   the provider's own plugin (Hindsight: hindsight-coding-agents); removes openmem hooks
  --no-provider-plugin  switch back to openmem hooks
The choice is saved as [agents] integration in ~/.config/personal-memory/config.toml.
--hindsight-plugin is a deprecated alias for --provider-plugin.

rtk on PATH: runs rtk init for each supported agent (skip with --no-rtk).
--context-proxy / --no-context-proxy: route Claude Code and OpenCode through the local
context proxy (saved as [context_proxy] enabled).
`;

function parseArgs(argv) {
  const flags = {
    yes: false,
    dry: false,
    help: false,
    providerPlugin: undefined,
    rtk: true,
    contextProxy: undefined,
    agents: [...DEFAULT_AGENT_IDS],
    unknown: [],
    deprecated: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes" || a === "-y") flags.yes = true;
    else if (a === "--dry-run") flags.dry = true;
    else if (a === "--help" || a === "-h") flags.help = true;
    else if (a === "--provider-plugin") flags.providerPlugin = true;
    else if (a === "--hindsight-plugin") {
      flags.providerPlugin = true;
      flags.deprecated.push("--hindsight-plugin is deprecated; use --provider-plugin");
    } else if (a === "--no-provider-plugin") flags.providerPlugin = false;
    else if (a === "--no-rtk") flags.rtk = false;
    else if (a === "--context-proxy") flags.contextProxy = true;
    else if (a === "--no-context-proxy") flags.contextProxy = false;
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

/** Resolve integration and proxy settings from flags, then config; persist flag choices. */
function resolveSettings({ home, stackRoot, flags, write, log }) {
  const cfg = loadPmConfig(home, stackRoot || home).merged;
  // Older callers pass `hindsightPlugin: true` directly.
  const providerFlag = flags.providerPlugin ?? (flags.hindsightPlugin ? true : undefined);
  const integration = providerFlag === undefined ? agentIntegrationFromPmConfig(cfg) : providerFlag ? "provider" : "openmem";
  const proxy = contextProxyFromPmConfig(cfg);
  if (flags.contextProxy !== undefined) proxy.enabled = flags.contextProxy;
  if (providerFlag !== undefined) {
    const r = updatePmConfigTable(home, "agents", { integration }, { dry: !write });
    log.info(`${r === "dry-run" ? "dry-run: would save" : "saved"} [agents] integration = "${integration}"`);
  }
  if (flags.contextProxy !== undefined) {
    const r = updatePmConfigTable(home, "context_proxy", { enabled: proxy.enabled }, { dry: !write });
    log.info(`${r === "dry-run" ? "dry-run: would save" : "saved"} [context_proxy] enabled = ${proxy.enabled}`);
  }
  return { integration, proxy };
}

export async function runInstallCodingAgent(opts) {
  const home = opts.home;
  const env = opts.env || process.env;
  const flags = opts.flags;
  const log = opts.h || h();
  for (const agentId of flags.agents) {
    if (!AGENT_IDS.includes(agentId)) {
      log.warn(`Unknown agent "${agentId}" (known: ${AGENT_IDS.join(", ")})`);
    }
  }
  for (const note of flags.deprecated || []) log.warn(note);
  const provider = resolveMemoryProvider(home, env);
  const caps = PROVIDER_CAPABILITIES[provider] || {};
  log.info(`Provider ${provider}: capabilities ${JSON.stringify(caps)}`);

  const dry = flags.dry || !flags.yes;
  const { integration, proxy } = resolveSettings({ home, stackRoot: opts.stackRoot, flags, write: !dry, log });
  const useProviderPlugin = integration === "provider" && PROVIDER_PLUGINS.includes(provider);
  if (integration === "provider" && !useProviderPlugin) {
    log.warn(`Provider ${provider} has no coding-agent plugin; installing openmem hooks instead`);
  }
  const shimAgents = flags.agents.filter((id) => SHIM_AGENT_IDS.includes(id) || id === "opencode");
  const runtimeRoot = prepareAgentRuntime({
    home, repoRoot: opts.repoRoot, stackRoot: opts.stackRoot, dry, h: log,
  });
  const upstreamCmd = () => {
    const apiUrl = resolveHindsightApiUrl({ home, stackRoot: opts.stackRoot, env });
    return ["npx", "-y", "@vectorize-io/hindsight-coding-agents", "install", ...flags.agents, "--server", "self-hosted", "--api-url", apiUrl];
  };
  if (flags.dry) {
    log.info("dry-run: would run install-mcp --yes");
    if (useProviderPlugin) {
      removeSessionShim({ home, agents: shimAgents, dry: true, h: log });
    } else {
      installSessionShim({ home, repoRoot: runtimeRoot, agents: shimAgents, dry: true, h: log });
      removeUpstreamHooks({ home, agents: shimAgents, dry: true, h: log });
    }
    installAgentAccess({ home, runtimeRoot, stackRoot: opts.stackRoot, agents: flags.agents, dry: true, h: log });
    if (flags.rtk) installRtk({ agents: flags.agents, env, dry: true, h: log });
    installContextProxy({ home, agents: flags.agents, enabled: proxy.enabled, port: proxy.port, dry: true, h: log });
    if (useProviderPlugin) log.info(`dry-run: would also run ${upstreamCmd().join(" ")}`);
    return { provider, integration, ran: false };
  }
  if (!flags.yes) {
    log.warn("Re-run with --yes to install MCP + session hooks");
    return { provider, integration, ran: false };
  }

  await runInstallMemoryMcp({
    home,
    repoRoot: runtimeRoot,
    stackRoot: opts.stackRoot,
    flags: { yes: true, dry: false, notebooklm: false, notebooklmOnly: false, providerOnly: false, noUnifiedMcp: false, help: false, unknown: [] },
    env,
    h: log,
  });
  if (useProviderPlugin) {
    removeSessionShim({ home, agents: shimAgents, h: log });
  } else {
    installSessionShim({ home, repoRoot: runtimeRoot, agents: shimAgents, dry: false, h: log });
    removeUpstreamHooks({ home, agents: shimAgents, h: log });
  }
  installAgentAccess({
    home, runtimeRoot, stackRoot: opts.stackRoot, agents: flags.agents, dry: false, h: log,
  });
  const rtk = flags.rtk ? installRtk({ agents: flags.agents, env, h: log, spawn: opts.spawn }) : { rtk: null, ran: [] };
  const proxyOut = installContextProxy({ home, agents: flags.agents, enabled: proxy.enabled, port: proxy.port, h: log });

  let status = 0;
  if (useProviderPlugin) {
    const cmd = upstreamCmd();
    log.info(`Installing upstream Hindsight plugin: ${cmd.join(" ")}`);
    const r = (opts.spawn || spawnSync)(cmd[0], cmd.slice(1), { stdio: "inherit", env });
    status = r.status ?? 1;
  }

  for (const agentId of flags.agents) {
    if (shimAgents.includes(agentId)) {
      const hooks = useProviderPlugin ? "upstream Hindsight hooks" : "openmem session hooks";
      const extras = [rtk.ran.includes(agentId) ? "rtk" : "", proxyOut.changed.includes(agentId) && proxy.enabled ? "context proxy" : ""].filter(Boolean);
      log.info(`  ${agentId}: ${hooks} + unified MCP${extras.length ? ` + ${extras.join(" + ")}` : ""}`);
    } else {
      const row = CODING_AGENTS.find((a) => a.id === agentId);
      log.info(`  ${agentId}: ${row?.sessionPath || "unified MCP memory_*"}`);
    }
  }
  if (proxy.enabled && flags.agents.includes("claude-code")) {
    log.info(`Context proxy enabled: Claude Code now sends every request to http://127.0.0.1:${proxy.port}; start the proxy before using Claude Code.`);
  }
  return { provider, integration, ran: true, status };
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
  return typeof out.status === "number" ? out.status : 0;
}

if (isMainModule(import.meta.url)) {
  main().then(
    (code) => process.exit(code ?? 0),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
