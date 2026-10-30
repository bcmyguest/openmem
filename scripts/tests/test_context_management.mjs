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
import { runContextCommand } from "../../cli/context-management.mjs";
import { chooseContextManagement, startContextProxy, stopContextProxy } from "../../wizard/lib/context-step.mjs";

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

// Wizard step: default from config (else off), saves only a change, dry run writes nothing.
{
  const home = tmpHome();
  const ctx = { yes: true, dry: true, home, pmMerged: {} };
  const { value, lines } = await captured(() => chooseContextManagement(ctx, "8"));
  check("step title printed", lines.some((l) => l.includes("== 8. Context management (smart compaction) ==")));
  check("step says what it does", lines.some((l) => /smart_compact_search/.test(l)) && lines.some((l) => /OpenCode 2 uses its native plugin/.test(l)));
  check("no config: default off", value === false && ctx.contextManagement === false);
  check("dry run plans the save", lines.some((l) => l.includes("[dry-run] would save [context_proxy] enabled = false")));
  check("dry run writes no config.toml", !fs.existsSync(cfgFile(home)));

  const on = { yes: true, dry: true, home, pmMerged: { context_proxy: { enabled: true, port: 4200 } } };
  const r2 = await captured(() => chooseContextManagement(on, "8"));
  check("config enabled=true: default on", r2.value === true);
  check("unchanged choice saves nothing", !r2.lines.some((l) => /(would save|saved) \[context_proxy\]/.test(l)));

  const real = { yes: true, dry: false, home, pmMerged: {} };
  await captured(() => chooseContextManagement(real, "8"));
  check("real run saves enabled = false", readCfg(home).context_proxy?.enabled === false);
  check("ctx.pmMerged follows the save", real.pmMerged.context_proxy?.enabled === false);
  fs.rmSync(home, { recursive: true, force: true });
}

// Wizard step: start/stop the compose service.
{
  const home = tmpHome();
  const base = { yes: true, dry: true, home, project: "pm-unit", repoRoot: home, memoryProvider: { compose: { profile: "hindsight" } } };
  const up = await captured(() => startContextProxy({ ...base, contextManagement: true }));
  check("on: dry run plans compose up of context-proxy with its profile",
    up.lines.some((l) => l.includes("[dry-run] docker compose -p pm-unit --profile hindsight --profile context-proxy up -d --no-build context-proxy")));
  check("on: dry run writes no key file", !fs.existsSync(path.join(home, ".config/personal-memory/context-proxy.env")));
  const offUp = await captured(() => startContextProxy({ ...base, contextManagement: false }));
  check("off: no compose up", offUp.lines.length === 0);

  const calls = [];
  const running = (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    return { status: 0, stdout: "abc123\n" };
  };
  const stop = await captured(() => stopContextProxy({ ...base, contextManagement: false }, running));
  check("off: checks the service with compose ps", calls.some((c) => c.endsWith("--profile context-proxy ps -q context-proxy")));
  check("off: dry run plans compose stop when it runs",
    stop.lines.some((l) => l.includes("[dry-run] docker compose -p pm-unit --profile hindsight --profile context-proxy stop context-proxy")));
  const idle = await captured(() => stopContextProxy({ ...base, contextManagement: false }, () => ({ status: 0, stdout: "" })));
  check("off: nothing to stop when not running", idle.lines.length === 0);
  const onStop = await captured(() => stopContextProxy({ ...base, contextManagement: true }, running));
  check("on: stop is a no-op", onStop.lines.length === 0);

  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude/settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4100" } }));
  const kept = await captured(() => stopContextProxy({ ...base, dry: false, contextManagement: false }, running));
  check("off: proxy left running while Claude Code points at it", kept.lines.some((l) => /left running: claude-code/.test(l)));
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
    return { status: 0, stdout: args.includes("ps") ? "abc\n" : "" };
  };
  const run = (argv) => runContextCommand({ argv, home, stackRoot, env: { HOME: home, PM_PROJECT: "pm-unit" }, log, spawn, fetch: DOWN });

  check("unknown action exits 2", (await run(["sideways"])) === 2);
  check("--help exits 0", (await run(["--help"])) === 0);

  logs.length = 0;
  writeCfg(home, "[context_proxy]\nenabled = true\nport = 4300\n");
  check("status exits 0", (await run(["status"])) === 0);
  check("status reports the config value and port", logs.some((l) => /context management: on/.test(l)) && logs.some((l) => /127\.0\.0\.1:4300: not answering/.test(l)));
  logs.length = 0;
  await run(["status", "--json"]);
  const json = JSON.parse(logs[0]);
  check("status --json shape", json.enabled === true && json.port === 4300 && json.proxyUp === false && Array.isArray(json.pointedAgents));

  calls.length = 0;
  logs.length = 0;
  check("on --dry-run exits 0", (await run(["on", "--dry-run"])) === 0);
  check("on --dry-run plans compose up", logs.some((l) => l === `[dry-run] docker compose -p pm-unit --project-directory ${stackRoot} --profile context-proxy up -d context-proxy`));
  check("on --dry-run runs install-coding-agent --yes --context-proxy --dry-run",
    calls.some((c) => /install-coding-agent\.mjs --yes --context-proxy --dry-run$/.test(c)));
  check("on --dry-run starts no container", !calls.some((c) => c.startsWith("docker")));
  check("on --dry-run writes no key file", !fs.existsSync(path.join(home, ".config/personal-memory/context-proxy.env")));

  calls.length = 0;
  check("on exits 0", (await run(["on", "--agents", "claude-code"])) === 0);
  check("on starts the service before wiring agents",
    calls[0]?.startsWith("docker compose -p pm-unit") && calls[0].endsWith("up -d context-proxy") && /--context-proxy --agents claude-code$/.test(calls[1] || ""), calls.join("\n"));
  check("on writes the key file", fs.existsSync(path.join(home, ".config/personal-memory/context-proxy.env")));
  check("on creates the store directories", fs.existsSync(path.join(home, ".local/share/openmem/context/sessions")));

  calls.length = 0;
  check("off exits 0", (await run(["off"])) === 0);
  check("off unwires agents, then stops the running service",
    /--no-context-proxy$/.test(calls[0] || "") && calls.some((c) => c.endsWith("ps -q context-proxy")) && calls.at(-1)?.endsWith("stop context-proxy"), calls.join("\n"));
  fs.rmSync(home, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log("all context management tests passed");
