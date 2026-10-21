#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInstallCodingAgent } from "../../cli/install-coding-agent.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok    ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "pm-ica-"));
const logs = [];
const h = { info: (m) => logs.push(m), ok: (m) => logs.push(m), warn: (m) => logs.push(m) };

{
  const out = await runInstallCodingAgent({
    home,
    repoRoot: ROOT,
    stackRoot: home,
    flags: { yes: false, dry: true, help: false, agents: ["codex"], unknown: [] },
    env: { MEMORY_PROVIDER: "mem0" },
    h,
  });
  check("mem0 dry-run no spawn", out.provider === "mem0" && out.ran === false);
  check("mem0 mentions MCP", logs.some((l) => /install-mcp|MCP/i.test(l)));
}

if (failed) process.exit(1);
console.log("all install-coding-agent tests passed");
