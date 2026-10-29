#!/usr/bin/env node
/** SessionStart banner + registration and /smart-compact force flags (docs/context-store.md). */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  contextRoot,
  isSmartCompactPrompt,
  sanitizeSessionId,
  SMART_COMPACT_MARKER,
} from "../../cli/coding-agent/context-store.mjs";
import { runHook, sessionBanner } from "../../cli/coding-agent/hook-runner.mjs";
import { PersonalMemoryPlugin } from "../../cli/coding-agent/opencode-plugin.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok    ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

const mode = (p) => fs.statSync(p).mode & 0o777;

function memoryFetch(calls) {
  return async (url, init) => {
    calls.push(String(url));
    const body = JSON.stringify({ results: [{ memory: "recalled fact" }], items: [{ text: "recalled fact" }] });
    return { ok: true, status: 200, text: async () => body };
  };
}

// Banner names knowledge tools only where PROVIDER_CAPABILITIES has them.
{
  const hs = sessionBanner("hindsight", "coding-agent::x");
  check("hindsight banner names memory_pages_search", hs.includes("memory_pages_search"));
  check("hindsight banner names memory_capture_initiative", hs.includes("memory_capture_initiative"));
  for (const provider of ["mem0", "cognee"]) {
    const b = sessionBanner(provider, "coding-agent::x");
    check(`${provider} banner omits knowledge tools`, !b.includes("memory_pages_search") && !b.includes("memory_capture_initiative"));
  }
  check("banner stays short", hs.split("\n").length <= 3, hs);
}

check("sid sanitizing replaces characters outside [A-Za-z0-9._-]", sanitizeSessionId("a/b c:d.e_f-9") === "a_b_c_d.e_f-9");
check("default context root", contextRoot("/h", {}) === "/h/.local/share/openmem/context");
check("OPENMEM_STATE_DIR override", contextRoot("/h", { OPENMEM_STATE_DIR: "/state" }) === "/state/context");
check("raw /smart-compact detected", isSmartCompactPrompt("/smart-compact") && isSmartCompactPrompt("  /smart-compact now"));
check("Claude command tag detected", isSmartCompactPrompt("<command-message>x</command-message>\n<command-name>/smart-compact</command-name>"));
check("expanded command body detected", isSmartCompactPrompt(`<!-- ${SMART_COMPACT_MARKER} -->\nThe OpenMem context proxy will trim`));
check("other prompts not detected", !isSmartCompactPrompt("/smart-compactor") && !isSmartCompactPrompt("explain /smart-compact"));

// SessionStart: registration + banner + recall, default state dir under the disposable HOME.
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pm-ctx-start-"));
  const repo = path.join(home, "Proj");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  const calls = [];
  const env = { PATH: process.env.PATH, HOME: home, MEMORY_PROVIDER: "mem0", MEM0_API_URL: "http://127.0.0.1:19999" };
  const out = await runHook("claude-code", "sessionStart", {
    home, env, repoRoot: ROOT, ev: { cwd: repo, session_id: "sess/1" }, fetchFn: memoryFetch(calls),
  });
  const ctx = out?.hookSpecificOutput?.additionalContext || "";
  check("SessionStart output has banner", ctx.startsWith("[openmem] Memory provider mem0, bank coding-agent::Proj."), ctx);
  check("SessionStart output keeps recall context", ctx.includes("recalled fact"), ctx);
  check("SessionStart still makes one bounded recall", calls.length === 1);
  const root = path.join(home, ".local/share/openmem/context");
  const file = path.join(root, "sessions", "sess_1.json");
  const reg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  check("registration written to sessions/<sid>.json", fs.existsSync(file));
  check(
    "registration fields",
    reg.session_id === "sess_1" && reg.agent === "claude-code" && reg.cwd === repo && reg.bank === "coding-agent::Proj"
      && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(reg.registered_at),
    JSON.stringify(reg),
  );
  check("registration file mode 600", fs.existsSync(file) && mode(file) === 0o600);
  check("context dirs mode 700", mode(root) === 0o700 && mode(path.join(root, "sessions")) === 0o700);
  fs.rmSync(home, { recursive: true, force: true });
}

// OPENMEM_STATE_DIR override, registration failure tolerance, and access denial.
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pm-ctx-state-"));
  const state = path.join(home, "state");
  const env = { PATH: process.env.PATH, HOME: home, MEMORY_PROVIDER: "mem0", MEM0_API_URL: "http://127.0.0.1:19999", OPENMEM_STATE_DIR: state };
  await runHook("codex", "sessionStart", { home, env, repoRoot: ROOT, ev: { cwd: home, session_id: "c1" }, fetchFn: memoryFetch([]) });
  check("OPENMEM_STATE_DIR receives the registration", fs.existsSync(path.join(state, "context/sessions/c1.json")));

  const blocked = path.join(home, "blocked");
  fs.writeFileSync(blocked, "not a directory");
  let threw = false;
  let out;
  try {
    out = await runHook("claude-code", "sessionStart", {
      home, env: { ...env, OPENMEM_STATE_DIR: blocked }, repoRoot: ROOT, ev: { cwd: home, session_id: "c2" }, fetchFn: memoryFetch([]),
    });
  } catch { threw = true; }
  check("registration failure does not fail SessionStart", !threw && Boolean(out?.hookSpecificOutput?.additionalContext));

  const cfg = path.join(home, ".config/personal-memory/coding-agent.json");
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, JSON.stringify({ disabled: true }));
  await runHook("claude-code", "sessionStart", { home, env, repoRoot: ROOT, ev: { cwd: home, session_id: "c3" }, fetchFn: memoryFetch([]) });
  check("denied access writes no registration", !fs.existsSync(path.join(state, "context/sessions/c3.json")));
  fs.rmSync(home, { recursive: true, force: true });
}

// Prompt hooks: /smart-compact writes the force flag and skips recall.
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pm-ctx-force-"));
  const env = { PATH: process.env.PATH, HOME: home, MEMORY_PROVIDER: "mem0", MEM0_API_URL: "http://127.0.0.1:19999" };
  const sessions = path.join(home, ".local/share/openmem/context/sessions");
  const calls = [];
  for (const [harness, ev] of [
    ["claude-code", { cwd: home, session_id: "cc", prompt: "/smart-compact" }],
    ["claude-code", { cwd: home, session_id: "cc-tag", prompt: "<command-name>/smart-compact</command-name>" }],
    ["codex", { cwd: home, session_id: "cx", prompt: "/smart-compact please" }],
    ["cursor-cli", { workspace_roots: [home], conversation_id: "cu", prompt: "/smart-compact" }],
  ]) {
    await runHook(harness, "prompt", { home, env, repoRoot: ROOT, ev, fetchFn: memoryFetch(calls) });
  }
  for (const sid of ["cc", "cc-tag", "cx", "cu"]) {
    const flag = path.join(sessions, `${sid}.force`);
    check(`force flag for ${sid}`, fs.existsSync(flag) && fs.statSync(flag).size === 0 && mode(flag) === 0o600);
  }
  check("smart-compact prompts make no recall call", calls.length === 0, calls.join(","));
  await runHook("claude-code", "prompt", { home, env, repoRoot: ROOT, ev: { cwd: home, session_id: "plain", prompt: "fix it" }, fetchFn: memoryFetch(calls) });
  check("ordinary prompt writes no flag and recalls", !fs.existsSync(path.join(sessions, "plain.force")) && calls.length === 1);

  const cfg = path.join(home, ".config/personal-memory/coding-agent.json");
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, JSON.stringify({ disabled: true }));
  await runHook("claude-code", "prompt", { home, env, repoRoot: ROOT, ev: { cwd: home, session_id: "off", prompt: "/smart-compact" }, fetchFn: memoryFetch(calls) });
  check("force flag is written even when memory hooks are disabled", fs.existsSync(path.join(sessions, "off.force")) && calls.length === 1);
  fs.rmSync(home, { recursive: true, force: true });
}

// OpenCode plugin: chat.message with /smart-compact writes the flag without a memory call.
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pm-ctx-opencode-"));
  const saved = { HOME: process.env.HOME, MEMORY_PROVIDER: process.env.MEMORY_PROVIDER, HINDSIGHT_URL: process.env.HINDSIGHT_URL, OPENMEM_STATE_DIR: process.env.OPENMEM_STATE_DIR };
  const oldFetch = globalThis.fetch;
  const calls = [];
  process.env.HOME = home;
  process.env.MEMORY_PROVIDER = "hindsight";
  process.env.HINDSIGHT_URL = "http://memory.test";
  delete process.env.OPENMEM_STATE_DIR;
  globalThis.fetch = async (url) => { calls.push(String(url)); return { ok: true, status: 200, text: async () => "{}" }; };
  try {
    const plugin = await PersonalMemoryPlugin({ client: { session: { messages: async () => ({ data: [] }) } }, directory: home });
    await plugin["chat.message"]({ sessionID: "oc/1" }, { parts: [{ type: "text", text: "/smart-compact" }] });
    check("OpenCode /smart-compact writes force flag", fs.existsSync(path.join(home, ".local/share/openmem/context/sessions/oc_1.force")));
    check("OpenCode /smart-compact makes no memory call", calls.length === 0);
  } finally {
    globalThis.fetch = oldFetch;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

if (failed) process.exit(1);
console.log("all context store hook tests passed");
