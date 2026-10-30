#!/usr/bin/env node
/**
 * Installer hardening: TOML-aware removal of the upstream Codex entry, atomic writes that keep
 * file modes, the context-proxy secret kept mode 600 with backup/restore of foreign settings,
 * the proxy liveness warning, config.toml trim keys reaching the stack .env, rtk skipping
 * OpenCode 2, and the --hindsight-plugin rename exit. Disposable HOMEs only.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import TOML from "@iarna/toml";
import { runInstallCodingAgent } from "../../cli/install-coding-agent.mjs";
import { upsertEnvFile, writeFileAtomic } from "../../cli/coding-agent/file-io.mjs";
import { contextProxyBackupPath, installContextProxy, probeContextProxy } from "../../cli/coding-agent/install-context-proxy.mjs";
import { installRtk } from "../../cli/coding-agent/install-rtk.mjs";
import { removeUpstreamAccess } from "../../cli/coding-agent/remove-upstream-access.mjs";
import { removeTomlPath, tomlStatements } from "../../cli/coding-agent/toml-edit.mjs";
import {
  contextProxyStackEnvFromPmConfig,
  contextTrimEnvFromPmConfig,
  contextTrimFromPmConfig,
  syncPmConfig,
  updatePmConfigTable,
  userConfigPath,
} from "../../wizard/lib/pm-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const UPSTREAM_ARGS = '["/home/u/.hindsight/coding-agents/dist/mcp-server.js"]';
// The context store must land inside each disposable HOME.
delete process.env.OPENMEM_STATE_DIR;

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

// --- S1: secret file modes, backup and restore ----------------------------------------------------
{
  const home = tmpHome("secret");
  const settings = writeAt(home, ".claude/settings.json", `${JSON.stringify({
    env: { ANTHROPIC_BASE_URL: "https://gateway.example", ANTHROPIC_CUSTOM_HEADERS: "x-team: blue", KEEP: "1" },
  }, null, 2)}\n`);
  fs.chmodSync(settings, 0o644);
  const oc = writeAt(home, ".config/opencode/opencode.json", `${JSON.stringify({
    provider: { anthropic: { options: { baseURL: "https://gw.example/v1", headers: { "x-litellm-api-key": "Bearer theirs", "x-other": "1" } } } },
  }, null, 2)}\n`);
  fs.chmodSync(oc, 0o644);

  installContextProxy({ home, agents: ["claude-code", "opencode"], enabled: true, port: 4100 });
  const env = JSON.parse(read(settings)).env;
  check("Claude settings with the key are mode 600", mode(settings) === 0o600, mode(settings).toString(8));
  check("OpenCode config with the key is mode 600", mode(oc) === 0o600, mode(oc).toString(8));
  check("Claude keeps the user's other header lines", env.ANTHROPIC_CUSTOM_HEADERS.split("\n")[0] === "x-team: blue" && /x-litellm-api-key: Bearer [0-9a-f]{64}$/.test(env.ANTHROPIC_CUSTOM_HEADERS));
  const backupFile = contextProxyBackupPath(home);
  const backup = JSON.parse(read(backupFile));
  check("backup holds the previous values, mode 600",
    backup.claudeCode.ANTHROPIC_BASE_URL === "https://gateway.example" && backup.opencode.header === "Bearer theirs" && mode(backupFile) === 0o600);

  installContextProxy({ home, agents: ["claude-code", "opencode"], enabled: true, port: 4100 });
  check("re-enable keeps the original backup", JSON.parse(read(backupFile)).claudeCode.ANTHROPIC_BASE_URL === "https://gateway.example");

  installContextProxy({ home, agents: ["claude-code", "opencode"], enabled: false, port: 4100 });
  const restored = JSON.parse(read(settings)).env;
  check("disable restores Claude's previous values",
    restored.ANTHROPIC_BASE_URL === "https://gateway.example" && restored.ANTHROPIC_CUSTOM_HEADERS === "x-team: blue" && restored.KEEP === "1", JSON.stringify(restored));
  const ocOptions = JSON.parse(read(oc)).provider.anthropic.options;
  check("disable restores OpenCode's previous values",
    ocOptions.baseURL === "https://gw.example/v1" && ocOptions.headers["x-litellm-api-key"] === "Bearer theirs" && ocOptions.headers["x-other"] === "1", JSON.stringify(ocOptions));
  check("backup removed after restore", !fs.existsSync(backupFile));

  // No prior values: disable removes our keys and leaves no backup.
  const fresh = tmpHome("fresh");
  installContextProxy({ home: fresh, agents: ["claude-code"], enabled: true, port: 4100 });
  check("fresh enable writes no backup", !fs.existsSync(contextProxyBackupPath(fresh)));
  installContextProxy({ home: fresh, agents: ["claude-code"], enabled: false, port: 4100 });
  check("fresh disable removes the env block", JSON.parse(read(path.join(fresh, ".claude/settings.json"))).env === undefined);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(fresh, { recursive: true, force: true });
}

// --- S7: liveness probe and warning; P2: stack .env sync ----------------------------------------
{
  check("probe: ok response is up", await probeContextProxy(4100, { fetch: async () => ({ ok: true }) }));
  check("probe: refused connection is down", !(await probeContextProxy(4100, { fetch: async () => { throw new Error("ECONNREFUSED"); } })));

  const home = tmpHome("probe");
  const stackRoot = path.join(home, "stack");
  const envFile = writeAt(home, "stack/.env", "HOST_UID=1000\nHOST_GID=1000\n");
  writeAt(home, ".config/personal-memory/config.toml", "[context_proxy]\nenabled = true\nport = 4300\ntrim_at_tokens = 90000\n[compaction]\nmax_chars = 8000\nnative = false\n");
  const { h, lines } = logger();
  const urls = [];
  const out = await runInstallCodingAgent({
    home,
    repoRoot: ROOT,
    stackRoot,
    flags: { yes: true, dry: false, help: false, agents: ["claude-code"], unknown: [], rtk: false },
    env: { PATH: "/usr/bin:/bin", HOME: home, MEMORY_PROVIDER: "hindsight", HINDSIGHT_URL: "http://127.0.0.1:18888" },
    h,
    spawn: () => ({ status: 0 }),
    fetch: async (url) => { urls.push(url); throw new Error("ECONNREFUSED"); },
  });
  check("install still succeeds with the proxy down", out.ran === true && out.status === 0);
  check("probe hits the configured port", urls[0] === "http://127.0.0.1:4300/health/liveliness", urls.join(","));
  const warning = lines.warn.join("\n");
  check("warning names the start command", warning.includes("NOT running") && warning.includes("--profile context-proxy up -d context-proxy") && warning.includes(stackRoot), warning);
  check("warning says how to disable", warning.includes("--no-context-proxy"));
  check("summary carries the start command", lines.info.some((m) => /start the proxy.*up -d context-proxy/.test(m)));
  const stackEnv = read(envFile);
  check("stack .env gets config trim keys and port",
    stackEnv.includes("CONTEXT_TRIM_AT_TOKENS=90000\n") && stackEnv.includes("CONTEXT_COMPACTION_MAX_CHARS=8000\n") && stackEnv.includes("CONTEXT_PROXY_PORT=4300\n")
    && !stackEnv.includes("CONTEXT_COMPRESS_OVER_TOKENS") && stackEnv.startsWith("HOST_UID=1000\n"), stackEnv);

  const upLog = logger();
  await runInstallCodingAgent({
    home, repoRoot: ROOT, stackRoot,
    flags: { yes: true, dry: false, help: false, agents: ["claude-code"], unknown: [], rtk: false },
    env: { PATH: "/usr/bin:/bin", HOME: home, MEMORY_PROVIDER: "hindsight", HINDSIGHT_URL: "http://127.0.0.1:18888" },
    h: upLog.h, spawn: () => ({ status: 0 }), fetch: async () => ({ ok: true }),
  });
  check("no warning when the proxy answers", !upLog.lines.warn.some((m) => m.includes("NOT running")));
  fs.rmSync(home, { recursive: true, force: true });
}

// --- P2 readers and S3 ----------------------------------------------------------------------------
{
  const cfg = { context_proxy: { trim_at_tokens: 50000, compress_over_tokens: -1, port: 4200 }, compaction: { max_chars: 900, native: false } };
  check("trim reader defaults", JSON.stringify(contextTrimFromPmConfig({})) === JSON.stringify({ trimAtTokens: 120000, compressOverTokens: 4000, compactionMaxChars: 12000, compactionNative: true, standingInstruction: true }));
  const t = contextTrimFromPmConfig(cfg);
  check("trim reader reads keys; invalid falls back", t.trimAtTokens === 50000 && t.compressOverTokens === 4000 && t.compactionMaxChars === 900 && t.compactionNative === false);
  check("trim env has only set, valid keys", JSON.stringify(contextTrimEnvFromPmConfig(cfg)) === JSON.stringify({ CONTEXT_TRIM_AT_TOKENS: "50000", CONTEXT_COMPACTION_MAX_CHARS: "900" }));
  check("stack env adds the port", contextProxyStackEnvFromPmConfig(cfg).CONTEXT_PROXY_PORT === "4200" && contextProxyStackEnvFromPmConfig({}).CONTEXT_PROXY_PORT === undefined);
  const off = TOML.parse("[context_proxy]\nstanding_instruction = false\n");
  check("standing_instruction = false reaches the reader and env", contextTrimFromPmConfig(off).standingInstruction === false
    && contextTrimEnvFromPmConfig(off).CONTEXT_STANDING_INSTRUCTION === "0"
    && contextTrimEnvFromPmConfig({ context_proxy: { standing_instruction: true } }).CONTEXT_STANDING_INSTRUCTION === "1"
    && contextTrimEnvFromPmConfig({ context_proxy: { standing_instruction: "no" } }).CONTEXT_STANDING_INSTRUCTION === undefined
    && contextProxyStackEnvFromPmConfig(off).CONTEXT_STANDING_INSTRUCTION === "0");
  const recallOff = TOML.parse("[compaction]\nrecall = false\n");
  check("[compaction] recall reaches the env", contextTrimEnvFromPmConfig(recallOff).CONTEXT_COMPACTION_RECALL === "0"
    && contextTrimEnvFromPmConfig({ compaction: { recall: true } }).CONTEXT_COMPACTION_RECALL === "1"
    && contextTrimEnvFromPmConfig({ compaction: { recall: "no" } }).CONTEXT_COMPACTION_RECALL === undefined
    && contextProxyStackEnvFromPmConfig(recallOff).CONTEXT_COMPACTION_RECALL === "0");
  check("TOML integers are read",contextTrimFromPmConfig(TOML.parse("[context_proxy]\ntrim_at_tokens = 7\n")).trimAtTokens === 7);

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
