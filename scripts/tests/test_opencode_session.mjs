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
    // Trimming moved to smarter-compact: a legacy [context_proxy] section changes nothing.
    fs.mkdirSync(path.join(home, ".config/personal-memory"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config/personal-memory/config.toml"), "[context_proxy]\nenabled = true\n", { mode: 0o600 });
    const plugin = await PersonalMemoryPlugin({ client, directory: home });
    await plugin.event({ event: { type: "session.created", properties: { info: { id: "ses_abc/1" } } } });
    check("session.created writes no registration", !fs.existsSync(path.join(home, ".local/share/openmem")));
    check("plugin installs no chat.headers hook", !("chat.headers" in plugin));
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
