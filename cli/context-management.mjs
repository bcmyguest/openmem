#!/usr/bin/env node
/**
 * Context management (smart compaction) per agent: `[context_proxy.agents]` in config.toml (a missing key
 * follows `[context_proxy] enabled`; with neither set, opencode2 is on and the others off), the agent wiring (install-coding-agent) and the compose
 * `context-proxy` service. Shared by the setup wizard step, install-coding-agent and `openmem context`.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contextRoot } from "./coding-agent/context-store.mjs";
import { proxyCodeVersion, summarizeContextStats, summarizeEvents } from "./coding-agent/session-db.mjs";
import { agentsPointedAtContextProxy, ensureContextProxyKey, probeContextProxy } from "./coding-agent/install-context-proxy.mjs";
import { isMainModule } from "./is-main.mjs";
import { resolveStackRoot } from "./stack.mjs";
import {
  CONTEXT_AGENT_KEYS,
  contextAgentsFromPmConfig,
  contextProxyFromPmConfig,
  loadPmConfig,
  updatePmConfigContextAgents,
} from "../wizard/lib/pm-config.mjs";

/** Compose service and profile name (compose.yaml). */
export const CONTEXT_PROXY_SERVICE = "context-proxy";
/**
 * Agents whose "on" needs the proxy service. Codex goes through LiteLLM's ChatGPT-subscription pass-through,
 * which the pinned dev image has (PR #41522; docs/compatibility.md, footnote 9).
 */
export const SERVICE_AGENT_KEYS = ["claude-code", "opencode1", "codex"];
/** How each config key is served. */
export const CONTEXT_AGENT_ROUTE = {
  "claude-code": "context-proxy",
  opencode1: "context-proxy",
  codex: "context-proxy (ChatGPT login, /backend-api/codex)",
  opencode2: "native plugin",
};
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = "openmem context";

const HELP = `${BIN}: turn context management (smart compaction) on or off per agent

Usage:
  ${BIN} on  [--dry-run] [--agents a,b]   save [context_proxy.agents] <agent> = true, re-run
                                           install-coding-agent (starts the context-proxy service
                                           when a proxy-routed agent is on)
  ${BIN} off [--dry-run] [--agents a,b]   save <agent> = false, re-run install-coding-agent (stops
                                           the service when no proxy-routed agent is on)
  ${BIN} status [--json]                  per-agent values, proxy health, agents pointed at it, and
                                           the last 24 h of trims and fail-opens from the session store
  ${BIN} stats [--hours N] [--json]       rtk-gain-style table: trims, tokens trimmed, cache read/write,
                                           in/out, hit ratio, searches (default 168 h)

Agents: ${CONTEXT_AGENT_KEYS.join(", ")} (default: all). claude-code, opencode1 and codex go through
the context-proxy service (codex keeps its ChatGPT login); opencode2 trims in its own plugin (on when
config sets neither its key nor enabled).
Docs: docs/context-management.md`;

const STATS_MAX_HOURS = 24 * 30;

/** True when any agent that needs the service resolves on. */
export function proxyServiceNeeded(agents) {
  return SERVICE_AGENT_KEYS.some((k) => agents[k]);
}

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
 * Start the service (`on`) or stop it when it runs and no agent points at it (`!on`). Skipped when the
 * stack root has no compose.yaml. Returns what happened.
 * @param {{ home: string, stackRoot?: string, project: string, on: boolean, dry?: boolean, env?: NodeJS.ProcessEnv,
 *   spawn?: typeof spawnSync, log: { info: (m: string) => void, warn: (m: string) => void } }} opts
 * @returns {"started"|"stopped"|"kept"|"not-running"|"no-stack"|"failed"|"dry-run"}
 */
export function ensureContextProxyService({ home, stackRoot, project, on, dry = false, env = process.env, spawn = spawnSync, log }) {
  if (!stackRoot || !fs.existsSync(path.join(stackRoot, "compose.yaml"))) return "no-stack";
  const base = contextComposeArgs({ project, stackRoot });
  const opts = { cwd: stackRoot, env: { ...env } };
  const run = (args) => {
    const text = `docker ${args.join(" ")}`;
    if (dry) {
      log.info(`[dry-run] ${text}`);
      return 0;
    }
    log.info(text);
    return spawn("docker", args, { stdio: "inherit", ...opts }).status ?? 1;
  };
  if (on) {
    if (!dry) prepareContextProxyFiles(home, env);
    return run([...base, "up", "-d", CONTEXT_PROXY_SERVICE]) === 0 ? (dry ? "dry-run" : "started") : "failed";
  }
  if (!contextProxyRunning(base, opts, spawn)) return "not-running";
  const pointed = dry ? [] : agentsPointedAtContextProxy(home);
  if (pointed.length) {
    log.warn(`context-proxy left running: ${pointed.join(", ")} still point at it`);
    return "kept";
  }
  return run([...base, "stop", CONTEXT_PROXY_SERVICE]) === 0 ? (dry ? "dry-run" : "stopped") : "failed";
}

/** Proxy code version of the checkout the compose service mounts (stack root, else this package), or null. */
function checkoutProxyVersion(stackRoot) {
  for (const root of [stackRoot, PKG_ROOT].filter(Boolean)) {
    try { return proxyCodeVersion(path.join(root, "proxy", "openmem_context")); } catch { /* not there */ }
  }
  return null;
}

/**
 * Current state: per-agent values, port, whether the proxy answers, which agents point at it, and the
 * session store's recent events (summarizeEvents) with the checkout's proxy code version to compare.
 * @param {{ home: string, stackRoot?: string, fetch?: typeof fetch, env?: NodeJS.ProcessEnv, now?: number }} opts
 */
export async function contextStatus({ home, stackRoot, fetch, env = process.env, now }) {
  const cfg = loadPmConfig(home, stackRoot || home).merged;
  const { port } = contextProxyFromPmConfig(cfg);
  const { agents, saved, enabledSaved } = contextAgentsFromPmConfig(cfg);
  return {
    enabled: contextProxyFromPmConfig(cfg).enabled,
    enabledSaved,
    agents: Object.fromEntries(CONTEXT_AGENT_KEYS.map((k) => [k, { on: agents[k], saved: saved.includes(k), route: CONTEXT_AGENT_ROUTE[k] }])),
    port,
    proxyUp: await probeContextProxy(port, fetch ? { fetch } : {}),
    pointedAgents: agentsPointedAtContextProxy(home),
    events: summarizeEvents(path.join(contextRoot(home, env), "sessions"), now === undefined ? {} : { now }),
    checkoutProxyVersion: checkoutProxyVersion(stackRoot),
  };
}

/** Text lines for the events part of `status`. */
export function eventLines(s) {
  const e = s.events;
  const lines = [`last ${e.hours} h (${e.sessions} session${e.sessions === 1 ? "" : "s"}): ${e.trims} trim${e.trims === 1 ? "" : "s"}`
    + (e.trims ? `, ~${e.tokensSaved} tokens saved (estimated ${e.tokensBefore} -> ${e.tokensAfter}), ${e.dropped} messages dropped` : "")
    + `, ${e.failOpens} fail-open${e.failOpens === 1 ? "" : "s"} (request sent untrimmed)`];
  for (const x of e.lastErrors) lines.push(`  ${x.at} ${x.error} at ${x.location} (${x.version}, session ${x.session})`);
  lines.push(...usageLines(e.usage));
  const running = e.latest.proxy;
  if (running && s.checkoutProxyVersion) {
    lines.push(`proxy code: ${running === s.checkoutProxyVersion ? `${running}, matches the checkout`
      : `${running} in the last event, checkout is ${s.checkoutProxyVersion}; restart the context-proxy service to load it`}`);
  }
  lines.push("not recorded here: fail-opens before the session id is known or from the session database itself (proxy stderr only)");
  return lines;
}

/** Prompt-cache lines from summarizeEvents' `usage`; none when no usage event was recorded. */
function usageLines(u) {
  if (!u?.requests) return [];
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const ratio = u.hitRatio === null ? "n/a" : `${(u.hitRatio * 100).toFixed(1)}%`;
  const lines = [`prompt cache: ${plural(u.requests, "request")} (${u.withCacheCounts} with cache counts), hit ratio ${ratio}`
    + ` (read ${u.cacheReadTokens} / read + creation ${u.cacheCreationTokens} + uncached ${u.inputTokens})`];
  const avg = (g) => (g.withCacheCounts ? Math.round(g.cacheCreationTokens / g.withCacheCounts) : "n/a");
  lines.push(`  cache creation: ${u.newCut.cacheCreationTokens} on ${plural(u.newCut.requests, "request")} making a new cut`
    + ` (avg ${avg(u.newCut)}), ${u.other.cacheCreationTokens} on ${plural(u.other.requests, "other")} (avg ${avg(u.other)})`);
  const counts = Object.entries(u.breakpoints).map(([n, k]) => `${n}: ${k}`).join(", ");
  if (counts) {
    lines.push(`  cache_control breakpoints per request: ${counts}; top layouts `
      + u.breakpointLayouts.map((x) => `${x.at} (${x.requests})`).join(", "));
  }
  return lines;
}

/** Default window for `context stats` (longer than status's 24 h — idle overnight zeros the short view). */
export const STATS_WINDOW_HOURS = 168;

/** Compact token/count display (rtk gain style): 1.1M, 321.2K, 42. */
export function formatTok(n) {
  const v = Number(n) || 0;
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  if (a >= 1_000_000) {
    const s = (a / 1_000_000).toFixed(1).replace(/\.0$/, "");
    return `${sign}${s}M`;
  }
  if (a >= 1_000) {
    const s = (a / 1_000).toFixed(1).replace(/\.0$/, "");
    return `${sign}${s}K`;
  }
  return `${sign}${Math.round(a)}`;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function meter(ratio, width = 24) {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return `${"░".repeat(width)} n/a`;
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)} ${(clamped * 100).toFixed(1)}%`;
}

function kv(label, value) {
  return `${label.padEnd(22)}${value}`;
}

/**
 * rtk-gain-style table for `context stats`: the numbers that show whether smart compaction is working
 * (trims, tokens trimmed, cache read/write, in/out, hit ratio, searches).
 */
export function statsLines(s) {
  const u = s.usage || {};
  const t = s.tools || { searches: 0, sql: 0, gets: 0, searchHits: 0, sqlRows: 0, getChars: 0 };
  // Share of estimated prompt tokens removed when a trim fired (tokensBefore → tokensAfter).
  const trimRatio = s.tokensBefore > 0 ? s.tokensSaved / s.tokensBefore : null;
  const rule = "═".repeat(60);
  const thin = "─".repeat(72);
  const lines = [
    `OpenMem Context (last ${s.hours} h)`,
    rule,
    "",
    kv("Sessions:", String(s.sessions)),
    kv("Requests:", formatTok(u.requests || 0)),
    kv("Trims:", String(s.trims)),
    kv("Tokens trimmed:", s.trims
      ? `${formatTok(s.tokensSaved)}  (est. ${formatTok(s.tokensBefore)} → ${formatTok(s.tokensAfter)})`
      : "0"),
    // Of the estimated prompt at each trim, how much left the context.
    kv("% removed at trim:", meter(trimRatio)),
    kv("Msgs dropped:", formatTok(s.dropped)),
    kv("Fail-opens:", String(s.failOpens)),
    "",
    kv("Cache read:", formatTok(u.cacheReadTokens || 0)),
    kv("Cache write:", formatTok(u.cacheCreationTokens || 0)),
    kv("Input (uncached):", formatTok(u.inputTokens || 0)),
    kv("Output:", formatTok(u.outputTokens || 0)),
    // Provider-reported: cache_read / (cache_read + cache_write + uncached input).
    kv("% prompt from cache:", meter(u.hitRatio)),
    "",
    kv("Searches:", `${t.searches}  (${formatTok(t.searchHits)} hits)`),
    kv("SQL queries:", `${t.sql}  (${formatTok(t.sqlRows)} rows)`),
    kv("Blob gets:", `${t.gets}  (${formatTok(t.getChars)} chars)`),
    kv("Store:", `${formatTok(s.messages)} msgs (${formatTok(s.inContext)} in ctx / ${formatTok(s.outOfContext)} trimmed), `
      + `${formatTok(s.blobs?.files ?? 0)} blobs (${formatBytes(s.blobs?.bytes ?? 0)})`),
  ];
  for (const x of s.lastErrors || []) {
    lines.push(kv("Fail-open:", `${x.at} ${x.error} at ${x.location} (${x.session})`));
  }
  if (s.topSessions?.length) {
    lines.push("", "By Session", thin);
    lines.push(`  ${"#".padStart(2)}  ${"Session".padEnd(38)}  ${"Trims".padStart(5)}  ${"Dropped".padStart(8)}  ${"Trimmed/Total".padStart(13)}`);
    lines.push(thin);
    s.topSessions.forEach((x, i) => {
      const sid = x.session.length > 38 ? `${x.session.slice(0, 35)}...` : x.session;
      const trimmedTotal = `${formatTok(x.outOfContext)}/${formatTok(x.messages)}`;
      lines.push(`  ${String(i + 1).padStart(2)}. ${sid.padEnd(38)}  ${String(x.trims).padStart(5)}  ${formatTok(x.dropped).padStart(8)}  ${trimmedTotal.padStart(13)}`);
    });
    lines.push(thin);
  }
  if (s.unreadable) lines.push("", kv("Unreadable DBs:", String(s.unreadable)));
  return lines;
}

function parseArgs(argv) {
  const flags = { action: argv[0], dry: false, json: false, agents: [], hours: null, help: false, unknown: [] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") flags.dry = true;
    else if (a === "--json") flags.json = true;
    else if (a === "--agents") flags.agents = String(argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--hours") {
      const n = Number(argv[++i]);
      flags.hours = Number.isFinite(n) ? n : NaN;
    } else if (a === "--help" || a === "-h") flags.help = true;
    else flags.unknown.push(a);
  }
  if (["--help", "-h", "help"].includes(flags.action)) flags.help = true;
  return flags;
}

/**
 * `openmem context on|off|status|stats`. Returns the exit code.
 * @param {{ argv: string[], home: string, stackRoot: string, env?: NodeJS.ProcessEnv,
 *   log?: { info: (m: string) => void, warn: (m: string) => void },
 *   spawn?: typeof spawnSync, fetch?: typeof fetch, now?: number }} opts
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
  const badAgents = flags.agents.filter((a) => !CONTEXT_AGENT_KEYS.includes(a));
  if (!["on", "off", "status", "stats"].includes(flags.action) || flags.unknown.length || badAgents.length) {
    if (badAgents.length) log.warn(`unknown agent: ${badAgents.join(", ")} (known: ${CONTEXT_AGENT_KEYS.join(", ")})`);
    log.warn(HELP);
    return 2;
  }
  if (flags.action === "stats") {
    const hours = flags.hours === null ? STATS_WINDOW_HOURS : flags.hours;
    if (!Number.isFinite(hours) || hours < 1 || hours > STATS_MAX_HOURS) {
      log.warn(`--hours must be 1-${STATS_MAX_HOURS}`);
      return 2;
    }
    const s = summarizeContextStats(contextRoot(home, env), { hours, ...(opts.now === undefined ? {} : { now: opts.now }) });
    if (flags.json) log.info(JSON.stringify(s, null, 2));
    else for (const line of statsLines(s)) log.info(line);
    return 0;
  }
  if (flags.action === "status") {
    const s = await contextStatus({ home, stackRoot, fetch: opts.fetch, env });
    if (flags.json) log.info(JSON.stringify(s, null, 2));
    else {
      for (const [k, a] of Object.entries(s.agents)) {
        log.info(`${k.padEnd(12)} ${a.on ? "on " : "off"}  ${a.saved ? "saved" : s.enabledSaved ? `follows enabled = ${s.enabled}` : "default"}  (${a.route})`);
      }
      log.info(`context proxy http://127.0.0.1:${s.port}: ${s.proxyUp ? "up" : "not answering"}`);
      log.info(`agents pointed at the proxy: ${s.pointedAgents.length ? s.pointedAgents.join(", ") : "none"}`);
      for (const line of eventLines(s)) log.info(line);
    }
    return 0;
  }
  const on = flags.action === "on";
  const keys = flags.agents.length ? flags.agents : CONTEXT_AGENT_KEYS;
  const saved = updatePmConfigContextAgents(home, Object.fromEntries(keys.map((k) => [k, on])), { dry: flags.dry });
  const summary = keys.map((k) => `${k} = ${on}`).join(", ");
  log.info(`${saved.result === "dry-run" ? "[dry-run] would save" : "saved"} [context_proxy.agents] ${summary}`);
  // install-coding-agent follows the saved values: it wires agents and starts or stops the service.
  const args = [path.join(PKG_ROOT, "cli", "install-coding-agent.mjs"), "--yes"];
  if (flags.dry) args.push("--dry-run");
  return spawn(process.execPath, args, { stdio: "inherit", env }).status ?? 1;
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
