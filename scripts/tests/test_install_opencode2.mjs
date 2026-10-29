#!/usr/bin/env node
/**
 * install-coding-agent OpenCode wiring by major version: a fake `opencode` on PATH reports the
 * version; v2 gets a `plugins` directory entry and no context proxy, v1 keeps the `plugin` file
 * entry. Disposable HOME only.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInstallCodingAgent } from "../../cli/install-coding-agent.mjs";
import { opencodeMajorVersion, parseJsonc } from "../../cli/coding-agent/opencode-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok    ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

const read = (p) => fs.readFileSync(p, "utf8");

function fakeOpencode(dir, script) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "opencode"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return `${dir}:/usr/bin:/bin`;
}

function seedHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pm-opencode2-install-"));
  const file = path.join(home, ".config/opencode/opencode.jsonc");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `{
  // keep this comment
  "theme": "dark",
  "plugin": [
    "/old/personal-memory/agent-runtime/cli/coding-agent/opencode-plugin.mjs",
    "other-plugin"
  ],
  "provider": {
    "anthropic": { "options": { "baseURL": "http://127.0.0.1:4100/v1", "headers": { "x-litellm-api-key": "Bearer old" } } }
  }
}
`);
  return home;
}

async function install(home, pathEnv, flags = {}, logs = []) {
  return runInstallCodingAgent({
    home,
    repoRoot: ROOT,
    stackRoot: path.join(home, "stack"),
    flags: { yes: true, dry: false, help: false, agents: ["claude-code", "opencode"], unknown: [], rtk: false, ...flags },
    env: { PATH: pathEnv, HOME: home, MEMORY_PROVIDER: "hindsight", HINDSIGHT_URL: "http://127.0.0.1:18888" },
    h: { info: (m) => logs.push(m), ok: (m) => logs.push(m), warn: (m) => logs.push(m) },
    spawn: () => ({ status: 0 }),
  });
}

const opencodeConfig = (home) => {
  const text = read(path.join(home, ".config/opencode/opencode.jsonc"));
  return { text, value: parseJsonc(text) };
};
const runtimePlugin2 = (home) => path.join(home, ".local/share/personal-memory/agent-runtime/cli/coding-agent/opencode2-plugin");

// Version detection.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-opencode-version-"));
  const at = (script) => opencodeMajorVersion({ env: { PATH: fakeOpencode(path.join(dir, String(Math.random())), script) } });
  check("2.x is major 2", at("echo 2.2.1") === 2);
  check("OpenCode 2.2.1 output (opencode v2.2.1) is major 2", at("echo 'opencode v2.2.1'") === 2);
  check("prefixed output parses", at("echo 'opencode 3.0.0-beta.1'") === 3);
  check("1.x is major 1", at("echo 1.18.32") === 1);
  check("non-zero exit counts as 1", at("echo 2.0.0; exit 1") === 1);
  check("unparsable output counts as 1", at("echo dev") === 1);
  check("missing binary counts as 1", opencodeMajorVersion({ env: { PATH: path.join(dir, "none") } }) === 1);
  fs.rmSync(dir, { recursive: true, force: true });
}

// OpenCode 2: `plugins` directory entry, v1 entry removed, no context proxy even when enabled.
{
  const home = seedHome();
  const v2 = fakeOpencode(path.join(home, "bin2"), "echo 2.2.1");
  const logs = [];
  await install(home, v2, { contextProxy: true }, logs);
  let { text, value } = opencodeConfig(home);
  const dir = runtimePlugin2(home);
  check("v2 entry is the runtime plugin directory", JSON.stringify(value.plugins) === JSON.stringify([dir]), JSON.stringify(value.plugins));
  check("v2 plugin directory has its entry file", fs.existsSync(path.join(dir, "index.js")));
  check("v1 openmem entry removed, others kept", JSON.stringify(value.plugin) === JSON.stringify(["other-plugin"]), JSON.stringify(value.plugin));
  check("comments and unrelated keys kept", text.includes("// keep this comment") && value.theme === "dark");
  check("OpenCode 2 is not pointed at the proxy", !value.provider?.anthropic?.options?.baseURL && !value.provider?.anthropic?.options?.headers);
  const claude = JSON.parse(read(path.join(home, ".claude/settings.json")));
  check("Claude Code still uses the proxy", claude.env?.ANTHROPIC_BASE_URL === "http://127.0.0.1:4100");
  check("summary names native trimming", logs.some((m) => /opencode: .*native context trimming \(OpenCode 2; context proxy not used\)/.test(m)), logs.join("\n"));
  check("installer says the proxy is skipped", logs.some((m) => /OpenCode 2 trims natively; not pointed at the context proxy/.test(m)));

  const installed = spawnSync(process.execPath, ["--input-type=module", "-e",
    `const m = await import(${JSON.stringify(path.join(dir, "index.js"))}); console.log(m.default.id, typeof m.default.setup);`],
  { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home } });
  check("installed runtime plugin imports standalone", installed.status === 0 && installed.stdout.trim() === "openmem function", installed.stderr);

  await install(home, v2);
  ({ value } = opencodeConfig(home));
  check("v2 reinstall keeps one entry", value.plugins.length === 1);

  // Back to OpenCode 1: the `plugin` file entry returns, the `plugins` entry goes, the proxy is wired.
  const v1 = fakeOpencode(path.join(home, "bin1"), "echo 1.18.32");
  await install(home, v1);
  ({ value } = opencodeConfig(home));
  check("v1 entry restored", value.plugin.length === 2 && value.plugin.includes("other-plugin") && value.plugin.some((p) => p.endsWith("cli/coding-agent/opencode-plugin.mjs")), JSON.stringify(value.plugin));
  check("v2 entry removed on v1", Array.isArray(value.plugins) && value.plugins.length === 0, JSON.stringify(value.plugins));
  check("OpenCode 1 points at the proxy", value.provider?.anthropic?.options?.baseURL === "http://127.0.0.1:4100/v1");

  // Provider plugin mode removes the v2 entry too.
  await install(home, v2);
  await install(home, v2, { providerPlugin: true });
  ({ value } = opencodeConfig(home));
  check("--provider-plugin removes the OpenCode 2 entry", !JSON.stringify(value.plugins || []).includes("opencode2-plugin") && !JSON.stringify(value.plugin || []).includes("opencode-plugin.mjs"), JSON.stringify(value));
  fs.rmSync(home, { recursive: true, force: true });
}

// No opencode on PATH: OpenCode 1 wiring, as before.
{
  const home = seedHome();
  await install(home, "/usr/bin:/bin");
  const { value } = opencodeConfig(home);
  check("missing opencode installs the v1 entry", value.plugin.some((p) => p.endsWith("opencode-plugin.mjs")) && value.plugins === undefined);
  fs.rmSync(home, { recursive: true, force: true });
}

// Dry run names the version-specific entry and the proxy decision.
{
  const home = seedHome();
  const logs = [];
  await install(home, fakeOpencode(path.join(home, "bin2"), "echo 2.0.0"), { dry: true, contextProxy: true }, logs);
  check("dry run names the plugins key", logs.some((m) => /register opencode 2 plugin .*opencode2-plugin.*\("plugins"\)/.test(m)), logs.join("\n"));
  check("dry run says the proxy is skipped", logs.some((m) => /\[dry-run\] opencode: OpenCode 2 trims natively/.test(m)));
  fs.rmSync(home, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log("all OpenCode 2 install tests passed");
