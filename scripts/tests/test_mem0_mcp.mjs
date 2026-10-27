#!/usr/bin/env node
/**
 * mem0 MCP merge + launcher: no API key values in mcp.json; key loaded from env file only
 * into the child env (never logged).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareMem0McpEnv } from "../../cli/mem0-mcp.mjs";
import {
  mem0McpEntry,
  mem0McpScriptPath,
  mergeMem0McpServer,
  resolveMem0ApiUrl,
  resolveMem0EnvFilePath,
} from "../../providers/mem0/lib/mcp-install.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const KEY = "m0sk_test_secret_NEVER_IN_MCP_JSON";

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok    ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

const tmpRoots = [];
function tmp(label) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `pm-mem0-mcp-${label}-`));
  tmpRoots.push(d);
  return d;
}
process.on("exit", () => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});

const script = mem0McpScriptPath(ROOT);
check("launcher script exists", fs.existsSync(script));

{
  const home = tmp("url");
  const stack = tmp("stack");
  fs.mkdirSync(path.join(home, ".config/hindsight"), { recursive: true });
  fs.writeFileSync(
    path.join(stack, ".env"),
    `MEM0_API_URL=http://127.0.0.1:18888\nMEM0_API_KEY=${KEY}\n`,
  );
  const url = resolveMem0ApiUrl({ home, stackRoot: stack, env: {} });
  check("resolveMem0ApiUrl ignores key in .env", url === "http://127.0.0.1:18888");
  const envFile = resolveMem0EnvFilePath({ home, stackRoot: stack, env: {} });
  check("default env file under openmem", envFile.endsWith(".config/personal-memory/mem0.env"));
}

{
  const entry = mem0McpEntry({
    apiUrl: "http://127.0.0.1:18888/",
    scriptPath: script,
    envFile: "/tmp/fake/mem0.env",
  });
  const blob = JSON.stringify(entry);
  check("entry command is node", entry.command === "node" && entry.args[0] === script);
  check("entry sets API_URL and BASE_URL without trailing slash", entry.env.MEM0_API_URL === "http://127.0.0.1:18888" && entry.env.MEM0_BASE_URL === "http://127.0.0.1:18888");
  check("entry has MEM0_ENV_FILE path", entry.env.MEM0_ENV_FILE === "/tmp/fake/mem0.env");
  check("entry JSON has no API key string", !blob.includes("MEM0_API_KEY") && !blob.includes(KEY));
}

{
  const base = {
    mcpServers: {
      hindsight: { command: "keep-h" },
      codegraph: { command: "keep-cg" },
      notebooklm: { command: "keep-nlm" },
    },
  };
  const { mcp, changed } = mergeMem0McpServer(base, {
    apiUrl: "http://127.0.0.1:18888",
    scriptPath: script,
    envFile: path.join(os.homedir(), ".config/personal-memory/mem0.env"),
  });
  check("merge adds mem0", changed && mcp.mcpServers.mem0?.command === "node");
  check("merge keeps siblings", mcp.mcpServers.hindsight === base.mcpServers.hindsight && mcp.mcpServers.codegraph === base.mcpServers.codegraph && mcp.mcpServers.notebooklm === base.mcpServers.notebooklm);
  const again = mergeMem0McpServer(mcp, {
    apiUrl: "http://127.0.0.1:18888",
    scriptPath: script,
    envFile: path.join(os.homedir(), ".config/personal-memory/mem0.env"),
  });
  check("merge idempotent", again.changed === false);

  const written = JSON.stringify(mcp, null, 2);
  check("merged mcp document has no key value", !written.includes(KEY) && !/"MEM0_API_KEY"/.test(written));
}

{
  const home = tmp("launch");
  const envFile = path.join(home, ".config/personal-memory/mem0.env");
  fs.mkdirSync(path.dirname(envFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(envFile, `MEM0_API_KEY=${KEY}\n`, { mode: 0o600 });
  const prepared = prepareMem0McpEnv({
    MEM0_API_URL: "http://127.0.0.1:18888",
    MEM0_ENV_FILE: envFile,
  });
  check("launcher maps BASE_URL", prepared.env.MEM0_BASE_URL === "http://127.0.0.1:18888");
  check("launcher loads key from file", prepared.env.MEM0_API_KEY === KEY && prepared.hadKeyInEnv === false);
  check("launcher does not leave key in returned envFile path", prepared.envFile === envFile);

  const fromEnv = prepareMem0McpEnv({
    MEM0_API_URL: "http://127.0.0.1:18888",
    MEM0_API_KEY: "already-set",
    MEM0_ENV_FILE: envFile,
  });
  check("launcher prefers existing MEM0_API_KEY", fromEnv.env.MEM0_API_KEY === "already-set" && fromEnv.hadKeyInEnv === true);
}

if (failed) {
  console.error(`${failed} mem0 MCP test(s) failed`);
  process.exit(1);
}
console.log("all mem0 MCP tests passed");
