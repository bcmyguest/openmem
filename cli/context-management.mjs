#!/usr/bin/env node
/**
 * Context management (smart compaction) on/off: `[context_proxy] enabled` in config.toml,
 * the agent wiring (install-coding-agent) and the compose `context-proxy` service.
 * Shared by the setup wizard step and `openmem context on|off|status`.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contextRoot } from "./coding-agent/context-store.mjs";
import { agentsPointedAtContextProxy, ensureContextProxyKey, probeContextProxy } from "./coding-agent/install-context-proxy.mjs";
import { isMainModule } from "./is-main.mjs";
import { resolveStackRoot } from "./stack.mjs";
import { contextProxyFromPmConfig, loadPmConfig } from "../wizard/lib/pm-config.mjs";

/** Compose service and profile name (compose.yaml). */
export const CONTEXT_PROXY_SERVICE = "context-proxy";
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = "openmem context";

const HELP = `${BIN}: turn context management (smart compaction) on or off

Usage:
  ${BIN} on  [--dry-run] [--agents a,b]   save [context_proxy] enabled = true, start the
                                           context-proxy service, re-run install-coding-agent
  ${BIN} off [--dry-run] [--agents a,b]   save enabled = false, re-run install-coding-agent,
                                           stop the context-proxy service
  ${BIN} status [--json]                  config value, proxy health, agents pointed at it

Claude Code and OpenCode 1 go through the context-proxy compose service. OpenCode 2 trims in
its own plugin and ignores this switch; CONTEXT_PROXY_ENABLED=0 turns that off.
Docs: docs/context-management.md`;

/**
 * Key file and store directories the compose service needs before `up`
 * (env_file, and a bind mount with create_host_path: false).
 */
export function prepareContextProxyFiles(home, env = process.env) {
  ensureContextProxyKey(home);
  for (const sub of ["sessions", "blobs"]) fs.mkdirSync(path.join(contextRoot(home, env), sub), { recursive: true, mode: 0o700 });
}

/**
 * True when compose reports a container for the service.
 * @param {string[]} baseArgs `docker` arguments up to (not including) the compose subcommand
 * @param {{ cwd?: string, env?: Record<string, string | undefined> }} [opts]
 * @param {typeof spawnSync} [spawn]
 */
export function contextProxyRunning(baseArgs, opts = {}, spawn = spawnSync) {
  const r = spawn("docker", [...baseArgs, "ps", "-q", CONTEXT_PROXY_SERVICE], { encoding: "utf8", ...opts });
  return r.status === 0 && String(r.stdout || "").trim() !== "";
}

/** `docker` arguments for compose calls on the context-proxy profile from the stack root. */
export function contextComposeArgs({ project, stackRoot }) {
  return ["compose", "-p", project, ...(stackRoot ? ["--project-directory", stackRoot] : []), "--profile", CONTEXT_PROXY_SERVICE];
}

/**
 * Current state: config value and port, whether the proxy answers, which agents point at it.
 * @param {{ home: string, stackRoot?: string, fetch?: typeof fetch }} opts
 */
export async function contextStatus({ home, stackRoot, fetch }) {
  const cfg = loadPmConfig(home, stackRoot || home).merged;
  const { enabled, port } = contextProxyFromPmConfig(cfg);
  return {
    enabled,
    port,
    proxyUp: await probeContextProxy(port, fetch ? { fetch } : {}),
    pointedAgents: agentsPointedAtContextProxy(home),
  };
}

function parseArgs(argv) {
  const flags = { action: argv[0], dry: false, json: false, agents: "", help: false, unknown: [] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") flags.dry = true;
    else if (a === "--json") flags.json = true;
    else if (a === "--agents") flags.agents = String(argv[++i] || "");
    else if (a === "--help" || a === "-h") flags.help = true;
    else flags.unknown.push(a);
  }
  if (["--help", "-h", "help"].includes(flags.action)) flags.help = true;
  return flags;
}

/**
 * `openmem context on|off|status`. Returns the exit code.
 * @param {{ argv: string[], home: string, stackRoot: string, env?: NodeJS.ProcessEnv,
 *   log?: { info: (m: string) => void, warn: (m: string) => void },
 *   spawn?: typeof spawnSync, fetch?: typeof fetch }} opts
 */
export async function runContextCommand(opts) {
  const { home, stackRoot } = opts;
  const env = opts.env || process.env;
  const log = opts.log || { info: (m) => console.log(m), warn: (m) => console.warn(m) };
  const spawn = opts.spawn || spawnSync;
  const flags = parseArgs(opts.argv);
  if (flags.help) {
    log.info(HELP);
    return 0;
  }
  if (!["on", "off", "status"].includes(flags.action) || flags.unknown.length) {
    log.warn(HELP);
    return 2;
  }
  if (flags.action === "status") {
    const s = await contextStatus({ home, stackRoot, fetch: opts.fetch });
    if (flags.json) log.info(JSON.stringify(s, null, 2));
    else {
      log.info(`context management: ${s.enabled ? "on" : "off"} ([context_proxy] enabled = ${s.enabled})`);
      log.info(`context proxy http://127.0.0.1:${s.port}: ${s.proxyUp ? "up" : "not answering"}`);
      log.info(`agents pointed at the proxy: ${s.pointedAgents.length ? s.pointedAgents.join(", ") : "none"}`);
      log.info("OpenCode 2 trims in its own plugin whatever this says (CONTEXT_PROXY_ENABLED=0 turns it off)");
    }
    return 0;
  }
  const on = flags.action === "on";
  const cfg = loadPmConfig(home, stackRoot || home).merged;
  const project = env.PM_PROJECT || String(cfg.stack?.project || "") || "openmem";
  const base = contextComposeArgs({ project, stackRoot });
  const spawnOpts = { cwd: stackRoot, env: { ...env } };
  const dockerRun = (args) => {
    const text = `docker ${args.join(" ")}`;
    if (flags.dry) {
      log.info(`[dry-run] ${text}`);
      return 0;
    }
    log.info(text);
    return spawn("docker", args, { stdio: "inherit", ...spawnOpts }).status ?? 1;
  };
  const wire = () => {
    const args = [path.join(PKG_ROOT, "cli", "install-coding-agent.mjs"), "--yes", on ? "--context-proxy" : "--no-context-proxy"];
    if (flags.dry) args.push("--dry-run");
    if (flags.agents) args.push("--agents", flags.agents);
    return spawn(process.execPath, args, { stdio: "inherit", env }).status ?? 1;
  };
  // On: start the proxy before agents point at it. Off: unpoint agents before stopping it.
  if (on) {
    if (!flags.dry) prepareContextProxyFiles(home, env);
    const up = dockerRun([...base, "up", "-d", CONTEXT_PROXY_SERVICE]);
    if (up !== 0) log.warn("context-proxy did not start; agents are wired anyway (install-coding-agent warns until it answers)");
    return wire();
  }
  const wired = wire();
  if (wired !== 0) return wired;
  if (flags.dry) {
    log.info(`[dry-run] docker ${[...base, "stop", CONTEXT_PROXY_SERVICE].join(" ")} (when running)`);
    return 0;
  }
  if (!contextProxyRunning(base, spawnOpts, spawn)) {
    log.info("context-proxy is not running");
    return 0;
  }
  const pointed = agentsPointedAtContextProxy(home);
  if (pointed.length) {
    log.warn(`context-proxy left running: ${pointed.join(", ")} still point at it (run without --agents to unwire them)`);
    return 1;
  }
  return dockerRun([...base, "stop", CONTEXT_PROXY_SERVICE]);
}

if (isMainModule(import.meta.url)) {
  const home = process.env.HOME || "";
  const sr = resolveStackRoot({ pkgRoot: PKG_ROOT });
  runContextCommand({ argv: process.argv.slice(2), home, stackRoot: sr.root }).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
