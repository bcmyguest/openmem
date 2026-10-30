#!/usr/bin/env node
/**
 * Context management on/off: install-coding-agent honours [context_proxy] enabled without a flag,
 * the wizard step (wizard/lib/context-step.mjs), and `openmem context on|off|status`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import TOML from "@iarna/toml";
import { runInstallCodingAgent } from "../../cli/install-coding-agent.mjs";
import { eventLines, runContextCommand } from "../../cli/context-management.mjs";
import { SCHEMA, openSession, proxyCodeVersion, summarizeEvents } from "../../cli/coding-agent/session-db.mjs";
import { chooseContextManagement, startContextProxy, stopContextProxy } from "../../wizard/lib/context-step.mjs";
import { contextAgentsFromPmConfig, syncPmConfig, updatePmConfigContextAgents, updatePmConfigTable } from "../../wizard/lib/pm-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DOWN = async () => ({ ok: false });

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok    ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "pm-ctx-mgmt-"));
const cfgFile = (home) => path.join(home, ".config/personal-memory/config.toml");
const writeCfg = (home, text) => {
  fs.mkdirSync(path.dirname(cfgFile(home)), { recursive: true });
  fs.writeFileSync(cfgFile(home), text);
};
const readCfg = (home) => (fs.existsSync(cfgFile(home)) ? TOML.parse(fs.readFileSync(cfgFile(home), "utf8")) : {});
const claudeEnv = (home) => {
  const file = path.join(home, ".claude/settings.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).env || {} : {};
};
const silent = { info() {}, ok() {}, warn() {} };

/** Capture console output of an async call (wizard log helpers print to the console). */
async function captured(fn) {
  const lines = [];
  const { log, error } = console;
  console.log = (...a) => lines.push(a.join(" "));
  console.error = (...a) => lines.push(a.join(" "));
  try {
    return { value: await fn(), lines };
  } finally {
    console.log = log;
    console.error = error;
  }
}

function install(home, flags = {}) {
  return runInstallCodingAgent({
    home,
    repoRoot: ROOT,
    stackRoot: path.join(home, "stack"),
    flags: { yes: true, dry: false, help: false, agents: ["claude-code"], unknown: [], rtk: false, ...flags },
    env: { PATH: "/usr/bin:/bin", HOME: home, MEMORY_PROVIDER: "hindsight", HINDSIGHT_URL: "http://127.0.0.1:18888" },
    h: silent,
    spawn: () => ({ status: 0 }),
    fetch: DOWN,
  });
}

// install-coding-agent: no flag → [context_proxy] enabled decides; a flag overrides and is saved.
{
  const home = tmpHome();
  writeCfg(home, "[context_proxy]\nenabled = true\n");
  await install(home);
  check("config enabled=true without a flag points Claude Code at the proxy", claudeEnv(home).ANTHROPIC_BASE_URL === "http://127.0.0.1:4100");
  writeCfg(home, "[context_proxy]\nenabled = false\n");
  await install(home);
  check("config enabled=false without a flag unpoints Claude Code", !("ANTHROPIC_BASE_URL" in claudeEnv(home)));
  writeCfg(home, "[context_proxy]\nenabled = true\n");
  await install(home, { contextProxy: false });
  check("--no-context-proxy overrides config enabled=true", !("ANTHROPIC_BASE_URL" in claudeEnv(home)));
  check("the overriding flag is saved", readCfg(home).context_proxy?.enabled === false);
  fs.rmSync(home, { recursive: true, force: true });
}
{
  const home = tmpHome();
  await install(home);
  check("no config and no flag leaves context management off", !("ANTHROPIC_BASE_URL" in claudeEnv(home)));
  check("no flag writes no [context_proxy] table", readCfg(home).context_proxy === undefined);
  fs.rmSync(home, { recursive: true, force: true });
}

// install-coding-agent: [context_proxy.agents] per agent, missing keys follow enabled; flags override every agent.
{
  const home = tmpHome();
  writeCfg(home, "[context_proxy]\nenabled = true\n[context_proxy.agents]\nclaude-code = false\n");
  await install(home);
  check("per-agent claude-code = false wins over enabled = true", !("ANTHROPIC_BASE_URL" in claudeEnv(home)));
  writeCfg(home, "[context_proxy]\nenabled = false\n[context_proxy.agents]\nclaude-code = true\n");
  await install(home);
  check("per-agent claude-code = true wins over enabled = false", claudeEnv(home).ANTHROPIC_BASE_URL === "http://127.0.0.1:4100");
  writeCfg(home, "[context_proxy]\nenabled = true\n[context_proxy.agents]\nclaude-code = false\n");
  await install(home, { contextProxy: true });
  check("--context-proxy overrides a per-agent false", claudeEnv(home).ANTHROPIC_BASE_URL === "http://127.0.0.1:4100");
  fs.rmSync(home, { recursive: true, force: true });
}

// install-coding-agent manages the service when the stack root has compose.yaml.
{
  const home = tmpHome();
  const stackRoot = path.join(home, "stack");
  fs.mkdirSync(stackRoot, { recursive: true });
  fs.writeFileSync(path.join(stackRoot, "compose.yaml"), "services: {}\n");
  const docker = [];
  let running = "";
  const fakeDocker = (cmd, args) => {
    docker.push([cmd, ...args].join(" "));
    return { status: 0, stdout: args.includes("ps") ? running : "" };
  };
  const run = (flags = {}) => runInstallCodingAgent({
    home, repoRoot: ROOT, stackRoot,
    flags: { yes: true, dry: false, help: false, agents: ["claude-code"], unknown: [], rtk: false, ...flags },
    env: { PATH: "/usr/bin:/bin", HOME: home, MEMORY_PROVIDER: "hindsight", HINDSIGHT_URL: "http://127.0.0.1:18888", PM_PROJECT: "pm-unit" },
    h: silent, spawn: () => ({ status: 0 }), docker: fakeDocker, fetch: DOWN,
  });
  writeCfg(home, "[context_proxy.agents]\nclaude-code = true\n");
  await run();
  check("installer starts the service when a proxy-routed agent is on",
    docker.some((c) => c === `docker compose -p pm-unit --project-directory ${stackRoot} --profile context-proxy up -d context-proxy`), docker.join("\n"));
  docker.length = 0;
  writeCfg(home, "[context_proxy.agents]\nclaude-code = false\nopencode1 = false\nopencode2 = true\n");
  running = "ctxid\n";
  await run();
  check("installer stops the running service when no proxy-routed agent is on (opencode2 needs none)",
    docker.some((c) => c.endsWith("ps -q context-proxy")) && docker.at(-1)?.endsWith("stop context-proxy") && !docker.some((c) => c.includes(" up ")), docker.join("\n"));
  docker.length = 0;
  running = "";
  await run();
  check("installer does nothing when the service is not running", docker.every((c) => c.endsWith("ps -q context-proxy")));
  docker.length = 0;
  writeCfg(home, "[context_proxy.agents]\ncodex = true\n");
  await run();
  check("codex = true alone starts the service (Codex is proxy-routed)", docker.some((c) => c.endsWith("up -d context-proxy")), docker.join("\n"));
  docker.length = 0;
  const noStack = tmpHome();
  writeCfg(noStack, "[context_proxy.agents]\nclaude-code = true\n");
  await runInstallCodingAgent({
    home: noStack, repoRoot: ROOT, stackRoot: path.join(noStack, "stack"),
    flags: { yes: true, dry: false, help: false, agents: ["claude-code"], unknown: [], rtk: false },
    env: { PATH: "/usr/bin:/bin", HOME: noStack, MEMORY_PROVIDER: "hindsight", HINDSIGHT_URL: "http://127.0.0.1:18888" },
    h: silent, spawn: () => ({ status: 0 }), docker: fakeDocker, fetch: DOWN,
  });
  check("installer runs no docker without a stack compose.yaml", docker.length === 0);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(noStack, { recursive: true, force: true });
}

// Config: per-agent resolution, the writer, and syncPmConfig keeping the subtable.
{
  const home = tmpHome();
  const none = contextAgentsFromPmConfig({}).agents;
  check("no config: opencode2 on, proxy-routed agents off", none.opencode2 === true && ["claude-code", "opencode1", "codex"].every((k) => none[k] === false), JSON.stringify(none));
  const bare = contextAgentsFromPmConfig({ context_proxy: { port: 4100 } }).agents;
  check("[context_proxy] without enabled or opencode2: opencode2 on", bare.opencode2 === true && bare["claude-code"] === false, JSON.stringify(bare));
  check("explicit enabled = false turns opencode2 off", contextAgentsFromPmConfig({ context_proxy: { enabled: false } }).agents.opencode2 === false);
  check("explicit opencode2 = false turns it off", contextAgentsFromPmConfig({ context_proxy: { agents: { opencode2: false } } }).agents.opencode2 === false);
  const r = updatePmConfigContextAgents(home, { "claude-code": true, opencode2: false });
  check("writer sets enabled from the agents", r.enabled === true && readCfg(home).context_proxy?.enabled === true);
  check("writer stores [context_proxy.agents]", readCfg(home).context_proxy?.agents?.["claude-code"] === true && readCfg(home).context_proxy?.agents?.opencode2 === false);
  updatePmConfigContextAgents(home, { "claude-code": false });
  check("writer merges with saved keys", readCfg(home).context_proxy?.agents?.opencode2 === false && readCfg(home).context_proxy?.enabled === false);
  updatePmConfigTable(home, "context_proxy", { port: 4200 });
  syncPmConfig({ home, project: "pm-unit", memoryProvider: { id: "hindsight" } });
  const after = readCfg(home);
  check("syncPmConfig keeps [context_proxy.agents] and other keys", after.context_proxy?.agents?.["claude-code"] === false && after.context_proxy?.port === 4200 && after.memory?.provider === "hindsight");
  fs.rmSync(home, { recursive: true, force: true });
}

// Wizard step: multi-select of installed agents; defaults from saved values, else OpenCode 2 on and proxy agents off.
{
  const home = tmpHome();
  const ctx = { yes: true, dry: true, home, pmMerged: {} };
  const { value, lines } = await captured(() => chooseContextManagement(ctx, "8", ["claude-code", "opencode2"]));
  check("step title printed", lines.some((l) => l.includes("== 8. Context management (smart compaction) ==")));
  check("step says what it does", lines.some((l) => /smart_compact_search/.test(l)) && lines.some((l) => /OpenCode 2 uses its native plugin/.test(l)));
  check("nothing saved: OpenCode 2 on, Claude Code off", value.opencode2 === true && value["claude-code"] === false && ctx.contextAgents === value);
  check("nothing saved: agents not installed are off", value.opencode1 === false && value.codex === false);
  check("dry run plans the per-agent save", lines.some((l) => l.includes("[dry-run] would save [context_proxy.agents] claude-code = false, opencode1 = false, codex = false, opencode2 = true")));
  check("dry run writes no config.toml", !fs.existsSync(cfgFile(home)));

  const savedCfg = { context_proxy: { enabled: false, agents: { "claude-code": true, opencode1: false, codex: false, opencode2: false } } };
  const r2 = await captured(() => chooseContextManagement({ yes: true, dry: true, home, pmMerged: savedCfg }, "8", ["claude-code", "opencode2"]));
  check("saved values are the defaults", r2.value["claude-code"] === true && r2.value.opencode2 === false);
  check("unchanged choice saves nothing", !r2.lines.some((l) => /(would save|saved) \[context_proxy/.test(l)));
  const r3 = await captured(() => chooseContextManagement({ yes: true, dry: true, home, pmMerged: { context_proxy: { enabled: true } } }, "8", ["claude-code"]));
  check("saved enabled = true without agent keys: Claude Code defaults on", r3.value["claude-code"] === true);
  const r4 = await captured(() => chooseContextManagement({ yes: true, dry: true, home, pmMerged: {} }, "8", ["codex"]));
  check("codex is offered, off by default", !r4.lines.some((l) => /not offered|saved values kept/.test(l)) && r4.value.codex === false);

  const real = { yes: true, dry: false, home, pmMerged: {} };
  await captured(() => chooseContextManagement(real, "8", ["claude-code", "opencode2"]));
  const saved = readCfg(home).context_proxy;
  check("real run saves all four keys and enabled", saved?.enabled === true && saved?.agents?.opencode2 === true && saved?.agents?.["claude-code"] === false && saved?.agents?.codex === false);
  check("ctx.pmMerged follows the save", real.pmMerged.context_proxy?.agents?.opencode2 === true);
  fs.rmSync(home, { recursive: true, force: true });
}

// Wizard step: start/stop the compose service from the per-agent choice.
{
  const home = tmpHome();
  const base = { yes: true, dry: true, home, project: "pm-unit", repoRoot: home, memoryProvider: { compose: { profile: "hindsight" } } };
  const proxyOn = { "claude-code": true, opencode1: false, codex: false, opencode2: false };
  const nativeOnly = { "claude-code": false, opencode1: false, codex: false, opencode2: true };
  const up = await captured(() => startContextProxy({ ...base, contextAgents: proxyOn }));
  check("proxy agent on: dry run plans compose up of context-proxy with its profile",
    up.lines.some((l) => l.includes("[dry-run] docker compose -p pm-unit --profile hindsight --profile context-proxy up -d --no-build context-proxy")));
  check("proxy agent on: dry run writes no key file", !fs.existsSync(path.join(home, ".config/personal-memory/context-proxy.env")));
  const offUp = await captured(() => startContextProxy({ ...base, contextAgents: nativeOnly }));
  check("only OpenCode 2 on: no compose up", offUp.lines.length === 0);

  const calls = [];
  const running = (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    return { status: 0, stdout: "abc123\n" };
  };
  const stop = await captured(() => stopContextProxy({ ...base, contextAgents: nativeOnly }, running));
  check("no proxy agent: checks the service with compose ps", calls.some((c) => c.endsWith("--profile context-proxy ps -q context-proxy")));
  check("no proxy agent: dry run plans compose stop when it runs",
    stop.lines.some((l) => l.includes("[dry-run] docker compose -p pm-unit --profile hindsight --profile context-proxy stop context-proxy")));
  const idle = await captured(() => stopContextProxy({ ...base, contextAgents: nativeOnly }, () => ({ status: 0, stdout: "" })));
  check("no proxy agent: nothing to stop when not running", idle.lines.length === 0);
  const onStop = await captured(() => stopContextProxy({ ...base, contextAgents: proxyOn }, running));
  check("proxy agent on: stop is a no-op", onStop.lines.length === 0);

  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude/settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4100" } }));
  const kept = await captured(() => stopContextProxy({ ...base, dry: false, contextAgents: nativeOnly }, running));
  check("proxy left running while Claude Code points at it", kept.lines.some((l) => /left running: claude-code/.test(l)));
  fs.rmSync(home, { recursive: true, force: true });
}

// openmem context on|off|status
{
  const home = tmpHome();
  const stackRoot = path.join(home, "stack");
  const logs = [];
  const log = { info: (m) => logs.push(m), warn: (m) => logs.push(m) };
  const calls = [];
  const spawn = (cmd, args) => {
    calls.push([path.basename(cmd), ...args].join(" "));
    return { status: 0, stdout: "" };
  };
  const run = (argv) => runContextCommand({ argv, home, stackRoot, env: { HOME: home, PM_PROJECT: "pm-unit" }, log, spawn, fetch: DOWN });

  check("unknown action exits 2", (await run(["sideways"])) === 2);
  check("--help exits 0", (await run(["--help"])) === 0);
  check("unknown agent exits 2", (await run(["on", "--agents", "cursor"])) === 2);

  logs.length = 0;
  writeCfg(home, "[context_proxy]\nenabled = true\nport = 4300\n[context_proxy.agents]\nopencode2 = false\n");
  check("status exits 0", (await run(["status"])) === 0);
  check("status lists each agent with its source", logs.some((l) => /^claude-code\s+on\s+follows enabled = true\s+\(context-proxy\)$/.test(l)) && logs.some((l) => /^opencode2\s+off\s+saved\s+\(native plugin\)$/.test(l)), logs.join("\n"));
  check("status reports the port", logs.some((l) => /127\.0\.0\.1:4300: not answering/.test(l)));
  logs.length = 0;
  await run(["status", "--json"]);
  const json = JSON.parse(logs[0]);
  check("status --json shape", json.agents.opencode2.on === false && json.agents.opencode2.saved === true && json.agents["claude-code"].on === true && json.port === 4300 && json.proxyUp === false);

  calls.length = 0;
  logs.length = 0;
  check("on --dry-run exits 0", (await run(["on", "--agents", "claude-code", "--dry-run"])) === 0);
  check("on --dry-run plans the per-agent save", logs.some((l) => l === "[dry-run] would save [context_proxy.agents] claude-code = true"));
  check("on --dry-run runs install-coding-agent --yes --dry-run", calls.length === 1 && /install-coding-agent\.mjs --yes --dry-run$/.test(calls[0]));
  check("on --dry-run leaves config.toml alone", readCfg(home).context_proxy?.agents?.["claude-code"] === undefined);

  calls.length = 0;
  check("off --agents opencode1,codex exits 0", (await run(["off", "--agents", "opencode1,codex"])) === 0);
  const cfg = readCfg(home).context_proxy;
  check("off sets the named agents and freezes the others at their resolved value", cfg.agents.opencode1 === false && cfg.agents.codex === false && cfg.agents["claude-code"] === true && cfg.agents.opencode2 === false);
  check("enabled is true while any agent is on", cfg.enabled === true);
  check("off re-runs install-coding-agent without a proxy flag", calls.length === 1 && /install-coding-agent\.mjs --yes$/.test(calls[0]));
  await run(["off"]);
  check("off without --agents turns every agent off", Object.values(readCfg(home).context_proxy.agents).every((v) => v === false) && readCfg(home).context_proxy.enabled === false);
  fs.rmSync(home, { recursive: true, force: true });
}

{
  // Events summary: last 24 h only, trims and fail-opens across sessions, newest writer versions, v1 DBs skipped.
  const home = tmpHome();
  const dir = path.join(home, "sessions");
  const now = Date.parse("2026-10-30T12:00:00Z");
  const a = openSession(path.join(dir, "ses_a.db"));
  a.addEvent("trim", "2026-10-30T10:00:00Z", "proxy:aaaaaaaaaaaa", { tokens_before: 130000, tokens_after: 40000, dropped: 50 });
  a.addEvent("trim", "2026-10-28T10:00:00Z", "proxy:000000000000", { tokens_before: 9, tokens_after: 1, dropped: 1 });
  a.addEvent("fail_open", "2026-10-30T11:00:00Z", "proxy:bbbbbbbbbbbb", { error: "TypeError", location: "tokens.py:40" });
  openSession(path.join(dir, "ses_b.db")).addEvent("trim", "2026-10-30T09:00:00Z", "opencode:0.7.0",
    { tokens_before: 1000, tokens_after: 400, dropped: 4 });
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const v1 = new DatabaseSync(path.join(dir, "ses_v1.db"));
  for (const ddl of SCHEMA) v1.exec(ddl);
  v1.exec("PRAGMA user_version = 1");
  v1.close();
  const e = summarizeEvents(dir, { now });
  check("events summary counts the window", e.sessions === 2 && e.trims === 2 && e.tokensSaved === 90600 && e.dropped === 54
    && e.failOpens === 1 && e.unreadable === 0, JSON.stringify(e));
  check("events summary keeps the newest error and version per writer", e.lastErrors.length === 1
    && e.lastErrors[0].session === "ses_a" && e.lastErrors[0].error === "TypeError"
    && e.latest.proxy === "proxy:bbbbbbbbbbbb" && e.latest.opencode === "opencode:0.7.0", JSON.stringify(e));
  const lines = eventLines({ events: e, checkoutProxyVersion: "proxy:cccccccccccc" });
  check("status flags a stale proxy", lines.some((l) => l.includes("restart the context-proxy service")), lines.join("\n"));
  check("status reports a current proxy", eventLines({ events: e, checkoutProxyVersion: "proxy:bbbbbbbbbbbb" })
    .some((l) => l.includes("matches the checkout")));
  check("checkout proxy version has the proxy shape", /^proxy:[0-9a-f]{12}$/.test(proxyCodeVersion(path.join(ROOT, "proxy", "openmem_context"))));
  check("missing sessions dir summarizes to zero", summarizeEvents(path.join(home, "none"), { now }).trims === 0);
  fs.rmSync(home, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log("all context management tests passed");
