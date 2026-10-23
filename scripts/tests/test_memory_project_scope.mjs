#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { callUnifiedTool } from "../../cli/mcp/memory-facade.mjs";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pm-project-scope-"));
const oldHome = process.env.HOME;
const oldIndex = process.env.HINDSIGHT_INDEX_CONFIG;
const home = path.join(temp, "home");
const workspace = path.join(temp, "work", "repo");
const indexPath = path.join(temp, "index.yml");
const configPath = path.join(home, ".config", "personal-memory", "coding-agent.json");
fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(indexPath, `banks:\n  "${workspace}": project-index-bank\n`);
fs.writeFileSync(configPath, JSON.stringify({ optInOnly: true, optInPaths: [path.dirname(workspace)], mapPathToBank: { [workspace]: "project-personal-bank" } }));
process.env.HOME = home;
process.env.HINDSIGHT_INDEX_CONFIG = indexPath;
let fetchCalls = 0;
const noFetch = async () => { fetchCalls++; throw new Error("provider call forbidden"); };
try {
  const allowed = await callUnifiedTool({ provider: "hindsight" }, "memory_project_scope", { cwd: workspace }, noFetch);
  assert.equal(allowed.isError, false);
  const parsed = JSON.parse(allowed.content[0].text);
  assert.equal(parsed.bank, "project-index-bank");
  assert.equal(parsed.accessPermitted, true);
  assert.equal(parsed.indexConfigPath, indexPath);
  assert.deepEqual(parsed.indexBanks, { [workspace]: "project-index-bank" });
  assert.deepEqual(parsed.personalMemoryMapping, { [workspace]: "project-personal-bank" });
  const denied = await callUnifiedTool({ provider: "hindsight" }, "memory_project_scope", { cwd: path.join(temp, "elsewhere") }, noFetch);
  assert.equal(JSON.parse(denied.content[0].text).accessPermitted, false);
  const invalid = await callUnifiedTool({ provider: "hindsight" }, "memory_project_scope", { cwd: "relative/path" }, noFetch);
  assert.equal(invalid.isError, true);
  assert.equal(fetchCalls, 0);
  console.log("memory_project_scope reports local bank and access policy without provider calls");
} finally {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldIndex === undefined) delete process.env.HINDSIGHT_INDEX_CONFIG;
  else process.env.HINDSIGHT_INDEX_CONFIG = oldIndex;
  fs.rmSync(temp, { recursive: true, force: true });
}
