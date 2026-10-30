#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import TOML from "@iarna/toml";
import { prepareAgentRuntime } from "../../cli/coding-agent/runtime.mjs";
import { installAgentAccess } from "../../cli/coding-agent/install-access.mjs";
import { installSessionShim } from "../../cli/coding-agent/install-shim.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "pm-access-"));
const stackRoot = path.join(home, "stack");
const agents = ["claude-code", "codex", "cursor-cli", "opencode"];
const logger = { info() {}, ok() {}, warn() {} };

try {
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), '[mcp_servers.keep]\ncommand = "keep"\n');
  fs.writeFileSync(path.join(home, ".claude.json"), '{"mcpServers":{"keep":{"command":"keep"}}}\n');
  fs.mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config", "opencode", "opencode.json"), '{"mcp":{"keep":{"type":"local"}},"plugin":["other-plugin"]}\n');

  const runtimeRoot = prepareAgentRuntime({ home, repoRoot: root, stackRoot, h: logger });
  installAgentAccess({ home, runtimeRoot, stackRoot, agents, h: logger });
  installSessionShim({ home, repoRoot: runtimeRoot, agents, dry: false, h: logger });
  installSessionShim({ home, repoRoot: runtimeRoot, agents, dry: false, h: logger });
  installAgentAccess({ home, runtimeRoot, stackRoot, agents, h: logger });

  const script = path.join(runtimeRoot, "cli", "openmem-mcp.mjs");
  assert.ok(fs.existsSync(script));
  for (const rel of [".claude", ".agents", ".cursor", ".config/opencode"]) {
    assert.ok(fs.existsSync(path.join(home, rel, "skills", "openmem", "SKILL.md")));
  }

  const claude = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
  assert.equal(claude.mcpServers.keep.command, "keep");
  assert.deepEqual(claude.mcpServers["openmem"].args, [script]);
  const codexText = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
  const codex = TOML.parse(codexText);
  assert.equal(codex.mcp_servers.keep.command, "keep");
  assert.deepEqual(codex.mcp_servers["openmem"].args, [script]);
  assert.equal(codex.features.hooks, true);
  assert.equal(codex.sandbox_workspace_write.network_access, true);
  assert.equal((codexText.match(/\[mcp_servers\.openmem\]/g) || []).length, 1);
  const opencode = JSON.parse(fs.readFileSync(path.join(home, ".config", "opencode", "opencode.json"), "utf8"));
  assert.equal(opencode.mcp.keep.type, "local");
  assert.deepEqual(opencode.mcp["openmem"].command, ["node", script]);
  assert.ok(opencode.plugin.includes("other-plugin"));
  assert.ok(opencode.plugin.includes(path.join(runtimeRoot, "cli", "coding-agent", "opencode-plugin.mjs")));
  const claudeHooks = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8")).hooks;
  const codexHooks = JSON.parse(fs.readFileSync(path.join(home, ".codex", "hooks.json"), "utf8")).hooks;
  assert.equal(claudeHooks.SessionStart.length, 1);
  assert.equal(codexHooks.SessionStart.length, 1);
  assert.ok(JSON.stringify(claudeHooks).includes(runtimeRoot));
  assert.ok(JSON.stringify(codexHooks).includes(runtimeRoot));
  assert.ok(fs.readFileSync(path.join(home, ".cursor", "hooks.json"), "utf8").includes(runtimeRoot));

  const jsoncHome = path.join(home, "jsonc-profile");
  const jsoncDir = path.join(jsoncHome, ".config", "opencode");
  fs.mkdirSync(jsoncDir, { recursive: true });
  const jsoncFile = path.join(jsoncDir, "opencode.jsonc");
  fs.writeFileSync(jsoncFile, '{\n  // Keep this user setting.\n  "theme": "dark",\n  "plugin": ["other-plugin"],\n  "mcp": { "keep": { "type": "local" } },\n}\n');
  installSessionShim({ home: jsoncHome, repoRoot: runtimeRoot, agents: ["opencode"], dry: false, h: logger });
  installAgentAccess({ home: jsoncHome, runtimeRoot, stackRoot, agents: ["opencode"], h: logger });
  const jsoncText = fs.readFileSync(jsoncFile, "utf8");
  assert.ok(jsoncText.includes("// Keep this user setting."));
  const jsonc = JSON.parse(jsoncText.replace(/^\s*\/\/.*$/gm, "").replace(/,\s*}/g, "}"));
  assert.equal(jsonc.theme, "dark");
  assert.ok(jsonc.plugin.includes("other-plugin"));
  assert.ok(jsonc.plugin.includes(path.join(runtimeRoot, "cli", "coding-agent", "opencode-plugin.mjs")));
  assert.equal(jsonc.mcp.keep.type, "local");
  assert.deepEqual(jsonc.mcp["openmem"].command, ["node", script]);
  assert.equal(fs.existsSync(path.join(jsoncDir, "opencode.json")), false);

  fs.writeFileSync(jsoncFile, '{"mcp":{"old":{}},"mcp":{"active":{}},"plugin":[]}\n');
  installAgentAccess({ home: jsoncHome, runtimeRoot, stackRoot, agents: ["opencode"], h: logger });
  const effectiveJsonc = JSON.parse(fs.readFileSync(jsoncFile, "utf8"));
  assert.ok(effectiveJsonc.mcp.active);
  assert.deepEqual(effectiveJsonc.mcp["openmem"].command, ["node", script]);

  const explicitHome = path.join(home, "explicit-codex");
  fs.mkdirSync(path.join(explicitHome, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(explicitHome, ".codex", "config.toml"), '[features] # existing feature settings\nhooks = false\nother = ["x"]\n');
  installAgentAccess({ home: explicitHome, runtimeRoot, stackRoot, agents: ["codex"], h: logger });
  assert.equal(TOML.parse(fs.readFileSync(path.join(explicitHome, ".codex", "config.toml"), "utf8")).features.hooks, false);
  fs.writeFileSync(path.join(explicitHome, ".codex", "config.toml"), '[features] # existing feature settings\nother = ["x"]\n');
  installAgentAccess({ home: explicitHome, runtimeRoot, stackRoot, agents: ["codex"], h: logger });
  assert.equal(TOML.parse(fs.readFileSync(path.join(explicitHome, ".codex", "config.toml"), "utf8")).features.hooks, true);
  fs.writeFileSync(path.join(explicitHome, ".codex", "config.toml"), 'model = "gpt-6"');
  installAgentAccess({ home: explicitHome, runtimeRoot, stackRoot, agents: ["codex"], h: logger });
  const noNewline = TOML.parse(fs.readFileSync(path.join(explicitHome, ".codex", "config.toml"), "utf8"));
  assert.equal(noNewline.model, "gpt-6");
  assert.equal(noNewline.features.hooks, true);
  assert.equal(noNewline.sandbox_workspace_write.network_access, true);
  fs.writeFileSync(path.join(explicitHome, ".codex", "config.toml"), "[sandbox_workspace_write]\nnetwork_access = false\nwritable_roots = []\n");
  installAgentAccess({ home: explicitHome, runtimeRoot, stackRoot, agents: ["codex"], h: logger });
  const sandbox = TOML.parse(fs.readFileSync(path.join(explicitHome, ".codex", "config.toml"), "utf8")).sandbox_workspace_write;
  assert.equal(sandbox.network_access, false);
  assert.deepEqual(sandbox.writable_roots, []);
  fs.writeFileSync(path.join(explicitHome, ".codex", "config.toml"), '[mcp_servers."openmem"]\ncommand = "old"\n[mcp_servers."openmem".env]\nKEEP = "old"\n');
  installAgentAccess({ home: explicitHome, runtimeRoot, stackRoot, agents: ["codex"], h: logger });
  assert.deepEqual(TOML.parse(fs.readFileSync(path.join(explicitHome, ".codex", "config.toml"), "utf8")).mcp_servers["openmem"].args, [script]);
  console.log("agent access installs stable runtime, skills, MCP, and hooks");
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
