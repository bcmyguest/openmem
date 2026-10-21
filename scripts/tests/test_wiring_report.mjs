#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildWiringReport } from "../../cli/wiring-report.mjs";

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok    ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "pm-wiring-"));
const stack = home;
fs.mkdirSync(path.join(home, ".config/hindsight"), { recursive: true });
fs.writeFileSync(path.join(home, ".config/hindsight/wizard.conf"), "MEMORY_PROVIDER=mem0\n");
const mcpPath = path.join(home, ".cursor/mcp.json");
fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: { "personal-memory": { command: "node" } } }));

import { fileURLToPath } from "node:url";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const report = buildWiringReport({ home, stackRoot: stack, repoRoot, env: { MEMORY_PROVIDER: "mem0" } });
check("provider mem0", report.memory_provider === "mem0");
check("flags missing native mcp", report.issues.some((i) => i.includes("mem0")));
check("ok false when issues", report.ok === false);
check("mem0 session caps omit reflect", report.coding_agent.session_capabilities?.reflect === false);

if (failed) process.exit(1);
console.log("all wiring report tests passed");
