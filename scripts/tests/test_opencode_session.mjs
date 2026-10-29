#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PersonalMemoryPlugin } from "../../cli/coding-agent/opencode-plugin.mjs";

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok    ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

const saved = { HOME: process.env.HOME, MEMORY_PROVIDER: process.env.MEMORY_PROVIDER, HINDSIGHT_URL: process.env.HINDSIGHT_URL, OPENMEM_STATE_DIR: process.env.OPENMEM_STATE_DIR };
const oldFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => "{}" });
const client = { session: { messages: async () => ({ data: [] }) } };

async function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pm-oc-session-"));
  process.env.HOME = home;
  process.env.MEMORY_PROVIDER = "hindsight";
  process.env.HINDSIGHT_URL = "http://memory.test";
  delete process.env.OPENMEM_STATE_DIR;
  try {
    await fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

try {
  await withHome(async (home) => {
    const plugin = await PersonalMemoryPlugin({ client, directory: home });
    await plugin.event({ event: { type: "session.created", properties: { info: { id: "ses_abc/1" } } } });
    const file = path.join(home, ".local/share/openmem/context/sessions/ses_abc_1.json");
    const reg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    check("session.created writes a registration", reg?.session_id === "ses_abc_1" && reg.agent === "opencode" && reg.cwd === home, JSON.stringify(reg));
    check("registration names a bank", typeof reg?.bank === "string" && reg.bank.length > 0);
    check("registration is mode 600", fs.existsSync(file) && (fs.statSync(file).mode & 0o777) === 0o600);
    const out = { headers: {} };
    await plugin["chat.headers"]({ sessionID: "ses_abc" }, out);
    check("no session header without the context proxy", !("x-openmem-session-id" in out.headers));
  });

  await withHome(async (home) => {
    fs.mkdirSync(path.join(home, ".config/personal-memory"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config/personal-memory/context-proxy.env"), "LITELLM_MASTER_KEY=x\n", { mode: 0o600 });
    // S6: `[context_proxy] enabled` decides, not the env file (which disabling keeps).
    fs.writeFileSync(path.join(home, ".config/personal-memory/config.toml"), "[context_proxy]\nenabled = true\n", { mode: 0o600 });
    const plugin = await PersonalMemoryPlugin({ client, directory: home });
    const out = { headers: {} };
    await plugin["chat.headers"]({ sessionID: "ses_abc" }, out);
    check("session header sent when the context proxy is configured", out.headers["x-openmem-session-id"] === "ses_abc");
  });
} finally {
  globalThis.fetch = oldFetch;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

if (failed) process.exit(1);
console.log("all opencode session tests passed");
