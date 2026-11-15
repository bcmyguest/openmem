#!/usr/bin/env node
/**
 * Installer hardening: TOML-aware removal of the upstream Codex entry, atomic writes that keep
 * file modes, the read-only warning for agents left on the removed context proxy, legacy
 * config.toml tables surviving a wizard rewrite, rtk skipping OpenCode 2, and the --hindsight-plugin rename exit. Disposable HOMEs only.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import TOML from "@iarna/toml";
import { runInstallCodingAgent } from "../../cli/install-coding-agent.mjs";
import { upsertEnvFile, writeFileAtomic } from "../../cli/coding-agent/file-io.mjs";
import { installRtk } from "../../cli/coding-agent/install-rtk.mjs";
import { removeUpstreamAccess } from "../../cli/coding-agent/remove-upstream-access.mjs";
import { removeTomlPath, tomlStatements } from "../../cli/coding-agent/toml-edit.mjs";
import {
  syncPmConfig,
  updatePmConfigTable,
  userConfigPath,
} from "../../wizard/lib/pm-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const UPSTREAM_ARGS = '["/home/u/.hindsight/coding-agents/dist/mcp-server.js"]';

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok    ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

const read = (p) => fs.readFileSync(p, "utf8");
const mode = (p) => fs.statSync(p).mode & 0o777;
const tmpHome = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `pm-harden-${tag}-`));
const logger = () => {
  const lines = { info: [], ok: [], warn: [] };
  return { lines, h: { info: (m) => lines.info.push(m), ok: (m) => lines.ok.push(m), warn: (m) => lines.warn.push(m) } };
};
function writeAt(home, rel, text) {
  const file = path.join(home, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

// --- toml-edit lexer -------------------------------------------------------------------
{
  const text = `a = """
[not.a.table]
"""
b = [
  [1, 2],
  [3],
]
[t] # comment
"k.x" = 'v'
`;
  const st = tomlStatements(text);
  check("lexer skips multi-line strings and arrays", st.map((s) => `${s.kind}:${s.path.join(".")}`).join(",") === "kv:a,kv:b,table:t,kv:t.k.x",
    st.map((s) => `${s.kind}:${s.path.join(".")}`).join(","));
}

// --- S2: Codex upstream entry removal ------------------------------------------------------
{
  const tableForm = `# top comment
model = "gpt-5"

[mcp_servers.codegraph]
command = "codegraph"
args = [
  "serve",
  "--mcp",
]

# comment kept between tables
[mcp_servers.hindsight]
command = "node"
args = ${UPSTREAM_ARGS}

[mcp_servers.hindsight.env]
HINDSIGHT_MCP_HARNESS = "codex"

# trailing comment kept
[profiles.x]
model = "o3"
`;
  const out = removeTomlPath(tableForm, ["mcp_servers", "hindsight"]);
  const parsed = TOML.parse(out);
  check("table form: hindsight and its subtable removed", parsed.mcp_servers.hindsight === undefined, out);
  check("table form: other tables intact", parsed.mcp_servers.codegraph.args.join(" ") === "serve --mcp" && parsed.profiles.x.model === "o3");
  check("table form: comments outside the entry kept",
    out.includes("# top comment") && out.includes("# comment kept between tables") && out.includes("# trailing comment kept"), out);

  const inlineForm = `[mcp_servers]
codegraph = { command = "codegraph" }
hindsight = { command = "node", args = ${UPSTREAM_ARGS} }
other = { command = "x" }
`;
  const inline = TOML.parse(removeTomlPath(inlineForm, ["mcp_servers", "hindsight"]));
  check("inline form under [mcp_servers] removed", inline.mcp_servers.hindsight === undefined && inline.mcp_servers.codegraph && inline.mcp_servers.other);

  const dotted = TOML.parse(removeTomlPath(`[mcp_servers]\nhindsight.command = "node"\nhindsight.args = ${UPSTREAM_ARGS}\nkeep.command = "k"\n`, ["mcp_servers", "hindsight"]));
  check("dotted keys removed", dotted.mcp_servers.hindsight === undefined && dotted.mcp_servers.keep.command === "k");

  // Through removeUpstreamAccess: written file, and abort when the entry cannot be cut out.
  const home = tmpHome("codex");
  const file = writeAt(home, ".codex/config.toml", inlineForm);
  fs.chmodSync(file, 0o640);
  const { h, lines } = logger();
  const r = removeUpstreamAccess({ home, agents: ["codex"], h });
  check("removeUpstreamAccess reports the inline entry", r.removed.some((x) => x.kind === "mcp"));
  check("removeUpstreamAccess really removed it", TOML.parse(read(file)).mcp_servers.hindsight === undefined, read(file));
  check("rewrite keeps the file mode", mode(file) === 0o640, mode(file).toString(8));

  const nested = `mcp_servers = { hindsight = { command = "node", args = ${UPSTREAM_ARGS} } }\n`;
  writeAt(home, ".codex/config.toml", nested);
  const again = removeUpstreamAccess({ home, agents: ["codex"], h });
  check("unremovable entry: file untouched", read(file) === nested);
  check("unremovable entry: not reported removed, warned", !again.removed.length && lines.warn.some((m) => /left .* unchanged/.test(m)), lines.warn.join("\n"));
  fs.rmSync(home, { recursive: true, force: true });
}

// --- S5: atomic writes -------------------------------------------------------------------------
{
  const home = tmpHome("atomic");
  const file = writeAt(home, "a.json", "{}\n");
  fs.chmodSync(file, 0o604);
  writeFileAtomic(file, "{\"x\":1}\n");
  check("atomic write keeps mode", mode(file) === 0o604 && read(file) === "{\"x\":1}\n");
  writeFileAtomic(file, "y\n", { mode: 0o600 });
  check("atomic write applies an explicit mode", mode(file) === 0o600);
  const real = writeAt(home, "real/settings.json", "{}\n");
  const link = path.join(home, "link.json");
  fs.symlinkSync(real, link);
  writeFileAtomic(link, "z\n");
  check("atomic write goes through a symlink", fs.lstatSync(link).isSymbolicLink() && read(real) === "z\n");
  check("no temp files left", fs.readdirSync(home).every((n) => !n.endsWith(".tmp")));
  const envFile = writeAt(home, "stack/.env", "HOST_UID=1\nCONTEXT_TRIM_AT_TOKENS=1\n");
  upsertEnvFile(envFile, { CONTEXT_TRIM_AT_TOKENS: "5000" });
  check("upsertEnvFile replaces only its keys", read(envFile) === "HOST_UID=1\nCONTEXT_TRIM_AT_TOKENS=5000\n", read(envFile));
  fs.rmSync(home, { recursive: true, force: true });
}

// --- S7: agents left on the removed context proxy get a warning; nothing is edited ---------------
{
  const run = async (home) => {
    const { h, lines } = logger();
    const out = await runInstallCodingAgent({
      home,
      repoRoot: ROOT,
      flags: { yes: true, dry: true, help: false, agents: ["claude-code"], unknown: [], rtk: false },
      env: { PATH: "/usr/bin:/bin", HOME: home, MEMORY_PROVIDER: "hindsight", HINDSIGHT_URL: "http://127.0.0.1:18888" },
      h,
      spawn: () => ({ status: 0 }),
    });
    return { out, warning: lines.warn.join("\n") };
  };

  const home = tmpHome("legacy");
  writeAt(home, ".config/personal-memory/config.toml", "[context_proxy]\nenabled = true\nport = 4300\n");
  const claude = writeAt(home, ".claude/settings.json", `${JSON.stringify({
    env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4300", ANTHROPIC_CUSTOM_HEADERS: "x-litellm-api-key: Bearer k" },
  }, null, 2)}\n`);
  const oc = writeAt(home, ".config/opencode/opencode.json", `${JSON.stringify({
    provider: { anthropic: { options: { baseURL: "http://127.0.0.1:4300/v1", headers: { "x-litellm-api-key": "Bearer k" } } } },
  }, null, 2)}\n`);
  const codex = writeAt(home, ".codex/config.toml", 'model_provider = "openmem"\n\n[model_providers.openmem]\nbase_url = "http://127.0.0.1:4300/v1"\n');
  const before = [claude, oc, codex].map(read);
  const { out, warning } = await run(home);
  check("legacy proxy: dry-run install proceeds past the warning", out.ran === false && out.integration === "openmem");
  check("legacy proxy: warning names each agent and file",
    ["claude-code", "opencode", "codex"].every((a) => warning.includes(`${a}: remove`)) && [claude, oc, codex].every((f) => warning.includes(f)), warning);
  check("legacy proxy: warning points to smarter-compact", warning.includes("smarter-compact"));
  check("legacy proxy: settings are left untouched", [claude, oc, codex].every((f, i) => read(f) === before[i]));
  fs.rmSync(home, { recursive: true, force: true });

  // Another tool's loopback proxy (a different port, no openmem provider) is not ours.
  const other = tmpHome("other-proxy");
  writeAt(other, ".claude/settings.json", `${JSON.stringify({
    env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8787", ANTHROPIC_CUSTOM_HEADERS: "x-litellm-api-key: Bearer k" },
  }, null, 2)}\n`);
  writeAt(other, ".codex/config.toml", 'model_provider = "smarter-compact"\n');
  check("other loopback proxy: no warning", !(await run(other)).warning.includes("context proxy was removed"));
  fs.rmSync(other, { recursive: true, force: true });

  // Default port 4100 applies when config.toml has no [context_proxy] port.
  const dflt = tmpHome("default-port");
  writeAt(dflt, ".claude/settings.json", `${JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4100" } }, null, 2)}\n`);
  check("default port 4100 is detected", (await run(dflt)).warning.includes("claude-code: remove"));
  fs.rmSync(dflt, { recursive: true, force: true });
}

// --- S3: the wizard keeps legacy tables ----------------------------------------------------------
{
  const home = tmpHome("s3");
  updatePmConfigTable(home, "compaction", { native: false, max_chars: 5000 });
  syncPmConfig({ home, project: "p", action: "configure", memoryProvider: { id: "hindsight" }, dry: false });
  const doc = TOML.parse(read(userConfigPath(home)));
  check("wizard rewrite keeps [compaction]", doc.compaction?.native === false && doc.compaction?.max_chars === 5000, JSON.stringify(doc.compaction));
  fs.rmSync(home, { recursive: true, force: true });
}

// --- P5: rtk skips OpenCode 2 ---------------------------------------------------------------------
{
  const home = tmpHome("rtk");
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "rtk"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const calls = [];
  const spawn = (cmd, args) => { calls.push(args.join(" ")); return { status: 0 }; };
  const v2 = installRtk({ agents: ["claude-code", "opencode"], env: { PATH: bin }, spawn, opencodeMajor: 2 });
  check("OpenCode 2: no rtk --opencode", !calls.includes("init -g --opencode") && calls.includes("init -g --auto-patch") && !v2.ran.includes("opencode"), calls.join(" | "));
  calls.length = 0;
  installRtk({ agents: ["opencode"], env: { PATH: bin }, spawn, opencodeMajor: 1 });
  check("OpenCode 1: rtk --opencode runs", calls.includes("init -g --opencode"));
  fs.rmSync(home, { recursive: true, force: true });
}

// --- P3: renamed flag -------------------------------------------------------------------------------
{
  const home = tmpHome("flag");
  const r = spawnSync(process.execPath, [path.join(ROOT, "cli", "install-coding-agent.mjs"), "--hindsight-plugin"], {
    env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8",
  });
  check("--hindsight-plugin exits 2", r.status === 2, String(r.status));
  check("--hindsight-plugin names the new flag", /--hindsight-plugin was renamed to --provider-plugin/.test(r.stderr), r.stderr);
  check("--hindsight-plugin writes nothing", fs.readdirSync(home).length === 0);
  fs.rmSync(home, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log("all installer hardening tests passed");
