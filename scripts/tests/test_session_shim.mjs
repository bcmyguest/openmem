#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bankFromCwd } from "../../cli/coding-agent/bank-from-cwd.mjs";
import { runHook } from "../../cli/coding-agent/hook-runner.mjs";
import { installSessionShim } from "../../cli/coding-agent/install-shim.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok    ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

{
  check("bankFromCwd slug", bankFromCwd("/home/alice/src/MyApp").startsWith("coding-agent::"));
}

{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pm-shim-"));
  const out = installSessionShim({
    home,
    repoRoot: ROOT,
    agents: ["claude-code"],
    dry: true,
    h: { info: () => {}, ok: () => {}, warn: () => {} },
  });
  check("dry-run lists claude-code", out.installed.includes("claude-code"));

  installSessionShim({
    home,
    repoRoot: ROOT,
    agents: ["claude-code"],
    dry: false,
    h: { info: () => {}, ok: () => {}, warn: () => {} },
  });
  const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude/settings.json"), "utf8"));
  check("claude settings has SessionStart hook", Boolean(settings.hooks?.SessionStart?.[0]?.hooks?.[0]?.command?.includes("hook-runner.mjs")));
}

{
  /** @type {typeof fetch} */
  const fetchFn = async (url, init) => {
    if (String(url).includes("/search")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ provider: "mem0", query: "hi", result: { results: [{ memory: "context hit" }] } }),
      };
    }
    if (String(url).includes("/chat/completions")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: "context hit synthesized" } }] }),
      };
    }
    if (String(url).includes("/memories/recall") || String(url).includes("/memories?")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ provider: "mem0", query: "hi", result: { results: [{ memory: "context hit" }] } }),
      };
    }
    if (String(url).includes("/memories") && init?.method === "POST") {
      return { ok: true, status: 200, text: async () => JSON.stringify({ results: [{ id: "1" }] }) };
    }
    return { ok: false, status: 404, text: async () => "nope" };
  };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pm-shim-run-"));
  fs.mkdirSync(path.join(home, ".config/hindsight"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config/hindsight/wizard.conf"), "MEMORY_PROVIDER=mem0\n");
  const emitted = await runHook(
    "claude-code",
    "prompt",
    {
      home,
      env: { ...process.env, HOME: home, MEMORY_PROVIDER: "mem0", MEM0_API_URL: "http://127.0.0.1:19999" },
      repoRoot: ROOT,
      ev: { cwd: "/tmp/my-repo", prompt: "fix the bug", session_id: "s1" },
      fetchFn,
    },
  );
  check("prompt hook emits additionalContext", Boolean(emitted?.hookSpecificOutput?.additionalContext?.includes("context hit")));
}

if (failed) process.exit(1);
console.log("all session shim tests passed");
