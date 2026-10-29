#!/usr/bin/env node
/**
 * install-coding-agent with [agents] integration = "openmem" removes the upstream Hindsight
 * MCP server entries and skill copies; unrelated and user-defined entries survive. Disposable HOME only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import TOML from "@iarna/toml";
import { runInstallCodingAgent } from "../../cli/install-coding-agent.mjs";
import { isUpstreamMcpEntry } from "../../cli/coding-agent/remove-upstream-access.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const AGENTS = ["claude-code", "codex", "cursor-cli", "opencode"];
const NPX_DIST = "/home/u/.npm/_npx/abc123/node_modules/@vectorize-io/hindsight-coding-agents/dist";
const UPSTREAM_SKILL = `---
name: hindsight-coding-agent
description: How this machine's Hindsight coding-agent memory works.
---

# Hindsight
`;
const USER_HINDSIGHT = { command: "node", args: ["/opt/my-hindsight/server.js"], env: { HINDSIGHT_URL: "http://localhost:8888" } };

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

function writer(home) {
  return (rel, value) => {
    const file = path.join(home, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  };
}

/** Home with what `hindsight-coding-agents install` writes for all four agents, plus unrelated entries. */
function seedUpstreamHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pm-upstream-access-"));
  const dist = path.join(home, ".hindsight", "coding-agents", "dist");
  const write = writer(home);
  // `claude mcp add --scope user hindsight --env ... -- node <dist>/mcp-server.js`
  write(".claude.json", {
    numStartups: 3,
    mcpServers: {
      hindsight: { type: "stdio", command: "node", args: [path.join(dist, "mcp-server.js")], env: { HINDSIGHT_MCP_HARNESS: "claude-code" } },
      codegraph: { type: "stdio", command: "codegraph", args: ["serve", "--mcp"] },
    },
  });
  write(".codex/config.toml", `model = "gpt-5"

[features]
hooks = true

[mcp_servers.codegraph]
command = "codegraph"
args = ["serve", "--mcp"]

[mcp_servers.hindsight]
command = "node"
args = [${JSON.stringify(path.join(NPX_DIST, "mcp-server.js"))}]
env = { HINDSIGHT_MCP_HARNESS = "codex" }

[mcp_servers.hindsight-local]
command = "node"
args = ["/opt/my-hindsight/server.js"]
`);
  write(".cursor/mcp.json", {
    mcpServers: {
      hindsight: { command: "node", args: [path.join(dist, "mcp-server.js"), "${workspaceFolder}"], env: { HINDSIGHT_MCP_HARNESS: "cursor-cli" } },
      notebooklm: { command: "notebooklm-mcp" },
    },
  });
  write(".config/opencode/opencode.json", { plugin: [path.join(home, ".hindsight", "coding-agents")], mcp: { other: { type: "local", command: ["other"] } } });
  for (const root of [".claude/skills", ".agents/skills", ".cursor/skills"]) {
    write(`${root}/hindsight-coding-agent/SKILL.md`, UPSTREAM_SKILL);
  }
  write(".claude/skills/my-skill/SKILL.md", "---\nname: my-skill\n---\n");
  return home;
}

/** Home whose `hindsight` MCP entries and skill dir belong to the user, not the upstream installer. */
function seedUserHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pm-upstream-user-"));
  const write = writer(home);
  write(".claude.json", { mcpServers: { hindsight: { type: "http", url: "http://localhost:8888/mcp/" } } });
  write(".codex/config.toml", `[mcp_servers.hindsight]
command = "node"
args = ["/opt/my-hindsight/server.js"]

[mcp_servers.hindsight.env]
HINDSIGHT_URL = "http://localhost:8888"
`);
  write(".cursor/mcp.json", { mcpServers: { hindsight: USER_HINDSIGHT } });
  write(".cursor/skills/hindsight-coding-agent/SKILL.md", "---\nname: my-hindsight-notes\n---\n");
  return home;
}

async function install(home, flags, h = silent) {
  return runInstallCodingAgent({
    home,
    repoRoot: ROOT,
    stackRoot: path.join(home, "stack"),
    flags: { yes: true, dry: false, help: false, agents: AGENTS, unknown: [], rtk: false, ...flags },
    env: { PATH: "/usr/bin:/bin", HOME: home, MEMORY_PROVIDER: "hindsight", HINDSIGHT_URL: "http://127.0.0.1:18888" },
    h,
    spawn: () => ({ status: 0 }),
  });
}

function recorder() {
  const lines = [];
  const push = (m) => lines.push(String(m));
  return { lines, h: { info: push, ok: push, warn: push } };
}

function snapshot(home) {
  const files = [".claude.json", ".codex/config.toml", ".cursor/mcp.json"].map((rel) => read(path.join(home, rel)));
  const skills = [".claude/skills", ".agents/skills", ".cursor/skills"].map((r) => fs.existsSync(path.join(home, r, "hindsight-coding-agent")));
  return JSON.stringify({ files, skills });
}

// Matcher: upstream staged copy and npx copy only.
{
  check("matches staged upstream server", isUpstreamMcpEntry({ command: "node", args: ["/h/.hindsight/coding-agents/dist/mcp-server.js"] }));
  check("matches npx upstream server", isUpstreamMcpEntry({ command: "node", args: [`${NPX_DIST}/mcp-server.js`, "${workspaceFolder}"] }));
  check("matches Windows path", isUpstreamMcpEntry({ command: "node", args: ["C:\\Users\\u\\.hindsight\\coding-agents\\dist\\mcp-server.js"] }));
  check("ignores user server", !isUpstreamMcpEntry(USER_HINDSIGHT));
  check("ignores HTTP server", !isUpstreamMcpEntry({ type: "http", url: "http://localhost:8888/mcp/" }));
  check("ignores other command", !isUpstreamMcpEntry({ command: "npx", args: ["/h/.hindsight/coding-agents/dist/mcp-server.js"] }));
}

// Dry run: plan printed, nothing written.
{
  const home = seedUpstreamHome();
  const before = snapshot(home);
  const { lines, h } = recorder();
  await install(home, { yes: false, dry: true }, h);
  check("dry run changes nothing", snapshot(home) === before);
  const plan = lines.filter((l) => l.startsWith("[dry-run] remove upstream Hindsight") && /MCP server|skill/.test(l));
  check("dry run plans 3 MCP + 3 skill removals", plan.length === 6, plan.join("\n"));
  fs.rmSync(home, { recursive: true, force: true });
}

// openmem integration: upstream MCP + skills removed, everything else kept.
{
  const home = seedUpstreamHome();
  const { lines, h } = recorder();
  await install(home, {}, h);
  const claude = json(path.join(home, ".claude.json"));
  check("Claude upstream hindsight MCP removed", !("hindsight" in claude.mcpServers));
  check("Claude codegraph MCP and settings kept", claude.mcpServers.codegraph?.command === "codegraph" && claude.numStartups === 3);
  check("Claude openmem MCP installed", Boolean(claude.mcpServers.openmem));
  const codexText = read(path.join(home, ".codex/config.toml"));
  const codex = TOML.parse(codexText);
  check("Codex upstream hindsight MCP removed", !("hindsight" in codex.mcp_servers), codexText);
  check("Codex hindsight-local and codegraph kept", codex.mcp_servers["hindsight-local"]?.args?.[0] === "/opt/my-hindsight/server.js" && codex.mcp_servers.codegraph?.command === "codegraph");
  check("Codex model, features and openmem kept", codex.model === "gpt-5" && codex.features?.hooks === true && Boolean(codex.mcp_servers.openmem));
  const cursor = json(path.join(home, ".cursor/mcp.json"));
  check("Cursor upstream hindsight MCP removed", !("hindsight" in cursor.mcpServers));
  check("Cursor notebooklm and openmem kept", cursor.mcpServers.notebooklm?.command === "notebooklm-mcp" && Boolean(cursor.mcpServers.openmem));
  for (const root of [".claude/skills", ".agents/skills", ".cursor/skills"]) {
    check(`upstream skill removed from ${root}`, !fs.existsSync(path.join(home, root, "hindsight-coding-agent")));
    check(`openmem skill kept in ${root}`, fs.existsSync(path.join(home, root, "openmem", "SKILL.md")));
  }
  check("unrelated Claude skill kept", fs.existsSync(path.join(home, ".claude/skills/my-skill/SKILL.md")));
  const oc = json(path.join(home, ".config/opencode/opencode.json"));
  check("OpenCode upstream plugin removed, MCPs kept", !JSON.stringify(oc.plugin).includes(".hindsight") && oc.mcp.other && oc.mcp.openmem);
  const removedLines = lines.filter((l) => /removed upstream Hindsight (MCP server|skill)/.test(l));
  check("removals printed", removedLines.length === 6, removedLines.join("\n"));

  const again = recorder();
  await install(home, {}, again.h);
  check("second install removes nothing more", !again.lines.some((l) => /removed upstream Hindsight (MCP server|skill)/.test(l)));

  // provider integration: nothing new is removed (the upstream installer re-adds its own).
  writer(home)(".agents/skills/hindsight-coding-agent/SKILL.md", UPSTREAM_SKILL);
  const prov = recorder();
  await install(home, { providerPlugin: true }, prov.h);
  check("provider mode leaves the upstream skill", fs.existsSync(path.join(home, ".agents/skills/hindsight-coding-agent/SKILL.md")));
  check("provider mode prints no upstream MCP/skill removal", !prov.lines.some((l) => /upstream Hindsight .*(MCP server|skill)/.test(l)));
  fs.rmSync(home, { recursive: true, force: true });
}

// User-defined hindsight entries and a foreign skill with the upstream dir name survive.
{
  const home = seedUserHome();
  await install(home, {});
  check("user Claude hindsight HTTP MCP kept", json(path.join(home, ".claude.json")).mcpServers.hindsight?.url === "http://localhost:8888/mcp/");
  const codex = TOML.parse(read(path.join(home, ".codex/config.toml")));
  check("user Codex hindsight MCP and env subtable kept", codex.mcp_servers.hindsight?.args?.[0] === "/opt/my-hindsight/server.js" && codex.mcp_servers.hindsight.env?.HINDSIGHT_URL === "http://localhost:8888");
  check("user Cursor hindsight MCP kept", JSON.stringify(json(path.join(home, ".cursor/mcp.json")).mcpServers.hindsight) === JSON.stringify(USER_HINDSIGHT));
  check("foreign skill in upstream dir name kept", fs.existsSync(path.join(home, ".cursor/skills/hindsight-coding-agent/SKILL.md")));
  fs.rmSync(home, { recursive: true, force: true });
}

// Malformed config: warned and skipped, install continues.
{
  const home = seedUpstreamHome();
  writer(home)(".cursor/mcp.json", "{ not json");
  writer(home)(".codex/config.toml", "[[broken");
  const { lines, h } = recorder();
  let threw = null;
  try {
    await install(home, { dry: true, yes: false }, h);
  } catch (err) {
    threw = err;
  }
  check("malformed configs do not abort the dry run", threw === null, String(threw));
  check("malformed configs are reported", lines.some((l) => l.startsWith(`skipped ${path.join(home, ".cursor/mcp.json")}`)) && lines.some((l) => l.startsWith(`skipped ${path.join(home, ".codex/config.toml")}`)));
  fs.rmSync(home, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log("all upstream access removal tests passed");
