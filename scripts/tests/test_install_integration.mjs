#!/usr/bin/env node
/**
 * install-coding-agent: exclusive hook sets ([agents] integration), /smart-compact command,
 * rtk wiring via a fake rtk on PATH, and the context proxy opt-in. Disposable HOME only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import TOML from "@iarna/toml";
import { runInstallCodingAgent } from "../../cli/install-coding-agent.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const AGENTS = ["claude-code", "codex", "cursor-cli", "opencode"];
const UPSTREAM = (home, file) => `node "${home}/.hindsight/coding-agents/dist/${file}"`;

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok    ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

const read = (p) => fs.readFileSync(p, "utf8");
const json = (p) => JSON.parse(read(p));
const silent = { info() {}, ok() {}, warn() {} };

/** Home seeded with upstream Hindsight hooks in all four agents plus unrelated settings. */
function seedHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pm-integration-"));
  const write = (rel, value) => {
    const file = path.join(home, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  };
  const nested = (file, timeout) => ({ hooks: [{ type: "command", command: UPSTREAM(home, file), timeout }] });
  write(".claude/settings.json", {
    model: "opus",
    env: { KEEP_ME: "1" },
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "codegraph prompt-hook" }] }, nested("claude-hook.js", 30)],
      SessionStart: [nested("claude-sessionstart-hook.js", 30)],
      Stop: [nested("claude-stop-hook.js", 60)],
    },
  });
  write(".codex/hooks.json", {
    hooks: {
      SessionStart: [nested("codex-sessionstart-hook.js", 30)],
      UserPromptSubmit: [nested("codex-hook.js", 30)],
      Stop: [nested("codex-stop-hook.js", 60)],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "other-tool hook" }] }],
    },
  });
  write(".cursor/hooks.json", {
    version: 1,
    hooks: {
      sessionStart: [{ command: UPSTREAM(home, "cursor-sessionstart-hook.js"), timeout: 30 }],
      beforeSubmitPrompt: [{ command: UPSTREAM(home, "cursor-hook.js") }],
      stop: [{ command: UPSTREAM(home, "cursor-stop-hook.js"), timeout: 30 }],
      afterFileEdit: [{ command: "keep-cursor-hook" }],
    },
  });
  write(".config/opencode/opencode.jsonc", `{
  // keep this comment
  "theme": "dark",
  "plugin": [
    "${home}/.hindsight/coding-agents",
    "other-plugin"
  ]
}
`);
  return home;
}

function fakeSpawn(calls) {
  return (cmd, args) => {
    calls.push([cmd, ...args]);
    return { status: 0 };
  };
}

async function install(home, flags, extra = {}) {
  return runInstallCodingAgent({
    home,
    repoRoot: ROOT,
    stackRoot: path.join(home, "stack"),
    flags: { yes: true, dry: false, help: false, agents: AGENTS, unknown: [], rtk: false, ...flags },
    env: { PATH: "/usr/bin:/bin", HOME: home, MEMORY_PROVIDER: "hindsight", HINDSIGHT_URL: "http://127.0.0.1:18888", ...extra.env },
    h: extra.h || silent,
    spawn: extra.spawn || fakeSpawn([]),
  });
}

function hookText(home) {
  return [".claude/settings.json", ".codex/hooks.json", ".cursor/hooks.json", ".config/opencode/opencode.jsonc"]
    .map((rel) => read(path.join(home, rel))).join("\n");
}

const count = (text, needle) => text.split(needle).length - 1;

// Integration "openmem" (default): upstream hooks removed, openmem hooks installed.
{
  const home = seedHome();
  const spawned = [];
  const out = await install(home, {}, { spawn: fakeSpawn(spawned) });
  const text = hookText(home);
  check("default integration is openmem", out.integration === "openmem");
  check("openmem removes every upstream Hindsight hook", !/hindsight[-/]coding-agents/.test(text), text);
  check("openmem installs its hooks in all four agents", count(text, "coding-agent/hook-runner.mjs") === 9 && text.includes("coding-agent/opencode-plugin.mjs"));
  const claude = json(path.join(home, ".claude/settings.json"));
  check("unrelated Claude settings survive", claude.model === "opus" && claude.env.KEEP_ME === "1" && JSON.stringify(claude.hooks.UserPromptSubmit).includes("codegraph prompt-hook"));
  check("unrelated Codex hook survives", JSON.stringify(json(path.join(home, ".codex/hooks.json")).hooks.PreToolUse).includes("other-tool hook"));
  const cursor = json(path.join(home, ".cursor/hooks.json"));
  check("Cursor hooks nest under hooks with version 1", cursor.version === 1 && Array.isArray(cursor.hooks.sessionStart) && !("sessionStart" in cursor) && cursor.hooks.afterFileEdit?.[0]?.command === "keep-cursor-hook");
  const oc = read(path.join(home, ".config/opencode/opencode.jsonc"));
  check("OpenCode keeps comment and unrelated plugin", oc.includes("// keep this comment") && oc.includes("other-plugin") && oc.includes('"theme": "dark"'));
  check("openmem mode does not run the upstream installer", spawned.length === 0);
  const command = path.join(home, ".claude/commands/smart-compact.md");
  check("Claude /smart-compact command installed", fs.existsSync(command) && /trim this session's earlier context on the next request/.test(read(command)));

  await install(home, {});
  check("openmem reinstall does not duplicate hooks", count(hookText(home), "coding-agent/hook-runner.mjs") === 9);

  // Switch to provider: openmem hooks removed, upstream installer runs, MCP kept, choice saved.
  const calls = [];
  const logs = [];
  const prov = await install(home, { providerPlugin: true }, { spawn: fakeSpawn(calls), h: { info: (m) => logs.push(m), ok() {}, warn: (m) => logs.push(m) } });
  const after = hookText(home);
  check("provider integration selected", prov.integration === "provider");
  check("provider removes openmem hooks and plugin", !after.includes("coding-agent/hook-runner.mjs") && !after.includes("coding-agent/opencode-plugin.mjs"), after);
  check("provider runs the upstream installer", calls.some((c) => c[0] === "npx" && c.includes("@vectorize-io/hindsight-coding-agents") && c.includes("install")));
  check("provider keeps the unified MCP", Boolean(json(path.join(home, ".claude.json")).mcpServers?.openmem));
  check("provider removes the /smart-compact command", !fs.existsSync(command));
  check("unrelated settings survive the switch", JSON.stringify(json(path.join(home, ".claude/settings.json")).hooks.UserPromptSubmit).includes("codegraph prompt-hook"));
  const cfgFile = path.join(home, ".config/personal-memory/config.toml");
  check("provider choice persisted", TOML.parse(read(cfgFile)).agents?.integration === "provider");
  check("config.toml mode 600", (fs.statSync(cfgFile).mode & 0o777) === 0o600);

  const again = [];
  const persisted = await install(home, {}, { spawn: fakeSpawn(again) });
  check("without a flag the persisted provider choice is used", persisted.integration === "provider" && again.length === 1);

  const dep = [];
  await install(home, { providerPlugin: true, deprecated: ["--hindsight-plugin is deprecated; use --provider-plugin"] }, { h: { info() {}, ok() {}, warn: (m) => dep.push(m) } });
  check("deprecation note is printed", dep.some((m) => /deprecated/.test(m)));

  const back = await install(home, { providerPlugin: false });
  check("--no-provider-plugin returns to openmem", back.integration === "openmem" && count(hookText(home), "coding-agent/hook-runner.mjs") === 9);
  check("openmem choice persisted", TOML.parse(read(cfgFile)).agents?.integration === "openmem");
  fs.rmSync(home, { recursive: true, force: true });
}

// Legacy hindsightPlugin flag object and non-Hindsight providers.
{
  const home = seedHome();
  const calls = [];
  const out = await install(home, { hindsightPlugin: true }, { spawn: fakeSpawn(calls) });
  check("hindsightPlugin alias selects provider", out.integration === "provider" && calls.length === 1);
  const mem0 = await install(home, {}, { env: { MEMORY_PROVIDER: "mem0", MEM0_API_URL: "http://127.0.0.1:19999" }, spawn: fakeSpawn(calls) });
  check("provider without a plugin falls back to openmem hooks", mem0.integration === "provider" && calls.length === 1 && hookText(home).includes("coding-agent/hook-runner.mjs"));
  fs.rmSync(home, { recursive: true, force: true });
}

// rtk: a fake rtk on PATH records its arguments and adds a PreToolUse entry like rtk does.
{
  const home = seedHome();
  const bin = path.join(home, "bin");
  const argsLog = path.join(home, "rtk-args.log");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "rtk"), `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argsLog)}, args.join(" ") + "\\n");
if (args.includes("--auto-patch")) {
  const file = path.join(process.env.HOME, ".claude", "settings.json");
  const s = JSON.parse(fs.readFileSync(file, "utf8"));
  s.hooks = s.hooks || {};
  const list = (s.hooks.PreToolUse || []).filter((e) => !JSON.stringify(e).includes("rtk hook claude"));
  s.hooks.PreToolUse = [...list, { matcher: "Bash", hooks: [{ type: "command", command: "rtk hook claude" }] }];
  fs.writeFileSync(file, JSON.stringify(s, null, 2));
}
`, { mode: 0o755 });
  const env = { PATH: `${bin}:/usr/bin:/bin:${path.dirname(process.execPath)}` };
  const runReal = (await import("node:child_process")).spawnSync;
  const spawn = (cmd, args, o) => (cmd === "npx" ? { status: 0 } : runReal(cmd, args, o));
  await install(home, { rtk: true }, { env, spawn });
  await install(home, { rtk: true }, { env, spawn });
  const lines = read(argsLog).trim().split("\n");
  check("rtk init runs per supported agent", ["init -g --auto-patch", "init -g --codex", "init -g --agent cursor", "init -g --opencode"].every((l) => lines.includes(l)), lines.join(" | "));
  check("rtk runs once per agent per install", lines.length === 8, String(lines.length));
  const claude = json(path.join(home, ".claude/settings.json"));
  check("rtk entry survives an OpenMem reinstall without duplication", claude.hooks.PreToolUse?.length === 1 && count(JSON.stringify(claude.hooks), "coding-agent/hook-runner.mjs") === 3);
  fs.writeFileSync(argsLog, "");
  await install(home, { rtk: false }, { env, spawn });
  check("--no-rtk skips rtk", read(argsLog) === "");
  const noRtk = await install(home, { rtk: true }, { env: { PATH: "/usr/bin:/bin" }, spawn });
  check("missing rtk is a no-op", noRtk.status === 0);
  fs.rmSync(home, { recursive: true, force: true });
}

// Context proxy opt-in.
{
  const home = seedHome();
  const cfgFile = path.join(home, ".config/personal-memory/config.toml");
  const keyFile = path.join(home, ".config/personal-memory/context-proxy.env");
  const logs = [];
  await install(home, { contextProxy: true }, { h: { info: (m) => logs.push(m), ok() {}, warn() {} } });
  const key = read(keyFile).match(/^LITELLM_MASTER_KEY=([0-9a-f]{64})$/m)?.[1];
  check("context-proxy.env has a 32-byte hex key", Boolean(key));
  check("context-proxy.env mode 600", (fs.statSync(keyFile).mode & 0o777) === 0o600);
  let env = json(path.join(home, ".claude/settings.json")).env;
  check("Claude base URL defaults to port 4100", env.ANTHROPIC_BASE_URL === "http://127.0.0.1:4100");
  check("Claude custom header carries the key", env.ANTHROPIC_CUSTOM_HEADERS === `x-litellm-api-key: Bearer ${key}`);
  check("Claude env keeps unrelated keys", env.KEEP_ME === "1");
  const oc = read(path.join(home, ".config/opencode/opencode.jsonc"));
  check("OpenCode anthropic provider points at the proxy", oc.includes('"baseURL": "http://127.0.0.1:4100/v1"') && oc.includes(`"x-litellm-api-key": "Bearer ${key}"`) && oc.includes("// keep this comment"));
  check("proxy choice persisted", TOML.parse(read(cfgFile)).context_proxy?.enabled === true);
  check("summary says the proxy must run", logs.some((m) => /start the proxy/.test(m)));

  fs.writeFileSync(cfgFile, read(cfgFile).replace(/enabled = true/, "enabled = true\nport = 4200"));
  await install(home, {});
  env = json(path.join(home, ".claude/settings.json")).env;
  check("persisted port and key reused on reinstall", env.ANTHROPIC_BASE_URL === "http://127.0.0.1:4200" && env.ANTHROPIC_CUSTOM_HEADERS.endsWith(key));
  check("codex config untouched by the proxy", !read(path.join(home, ".codex/config.toml")).includes("127.0.0.1:4200"));

  await install(home, { contextProxy: false });
  const claude = json(path.join(home, ".claude/settings.json"));
  check("disable removes exactly the two Claude keys", !("ANTHROPIC_BASE_URL" in claude.env) && !("ANTHROPIC_CUSTOM_HEADERS" in claude.env) && claude.env.KEEP_ME === "1");
  const ocAfter = parseOpencode(read(path.join(home, ".config/opencode/opencode.jsonc")));
  check("disable removes the OpenCode proxy options", !ocAfter.provider?.anthropic && ocAfter.theme === "dark");
  check("disable persisted", TOML.parse(read(cfgFile)).context_proxy?.enabled === false && TOML.parse(read(cfgFile)).context_proxy?.port === 4200);
  check("key file kept after disable", read(keyFile).includes(key));
  fs.rmSync(home, { recursive: true, force: true });
}

function parseOpencode(text) {
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
}

if (failed) process.exit(1);
console.log("all install integration tests passed");
