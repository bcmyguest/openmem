#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PersonalMemoryPlugin } from "../../cli/coding-agent/opencode-plugin.mjs";
import { sessionBanner } from "../../cli/coding-agent/hook-runner.mjs";
import { RECALL_CLOSE, RECALL_OPEN, RECALL_PREFACE } from "../../cli/coding-agent/recall-frame.mjs";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "pm-opencode-plugin-"));
const oldHome = process.env.HOME;
const oldHindsightUrl = process.env.HINDSIGHT_URL;
const oldMemoryProvider = process.env.MEMORY_PROVIDER;
const oldFetch = globalThis.fetch;
const retained = [];
const recalls = [];
let messages = [];

process.env.HOME = home;
process.env.HINDSIGHT_URL = "http://memory.test";
process.env.MEMORY_PROVIDER = "hindsight";
globalThis.fetch = async (url, init) => {
  assert.equal(String(url), "http://memory.test/v1/default/banks/coding-agent%3A%3Atest-project/reflect");
  if (init.method === "POST" && JSON.parse(String(init.body)).query) {
    const query = JSON.parse(String(init.body)).query;
    recalls.push(query);
    return { ok: true, status: 200, text: async () => JSON.stringify({ text: `memory for: ${query}`, based_on: [] }) };
  }
  throw new Error(`unexpected memory request: ${init.method} ${url}`);
};

try {
  const plugin = await PersonalMemoryPlugin({
    client: { session: { messages: async () => ({ data: messages }) } },
    directory: "/tmp/test-project",
  });

  await plugin["chat.message"]({ sessionID: "session-1" }, { parts: [{ type: "text", text: "first prompt" }] });
  const system = [];
  await plugin["experimental.chat.system.transform"]({ sessionID: "session-1" }, { system });
  assert.deepEqual(recalls, ["first prompt"]);
  assert.match(system[0], /memory for: first prompt/);
  // Recall is framed as untrusted data inside the system entry.
  assert.ok(system[0].startsWith(`Personal memory for coding-agent::test-project:\n${RECALL_PREFACE}\n${RECALL_OPEN}\n`)
    && system[0].endsWith(`\n${RECALL_CLOSE}`), system[0]);

  messages = [
    { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "first prompt" }] },
    { info: { id: "m2", role: "assistant" }, parts: [{ type: "text", text: "first answer" }] },
  ];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init.body));
    if (String(url).endsWith("/memories") && init.method === "POST") {
      retained.push(body.items[0].content);
      return { ok: true, status: 200, text: async () => "{}" };
    }
    assert.equal(String(url), "http://memory.test/v1/default/banks/coding-agent%3A%3Atest-project/memories/recall");
    recalls.push(body.query);
    return { ok: true, status: 200, text: async () => JSON.stringify({ items: [{ text: `memory for: ${body.query}` }] }) };
  };
  await plugin.event({ event: { type: "session.idle", properties: { sessionID: "session-1" } } });
  assert.equal(retained.length, 1);
  assert.match(retained[0], /user: first prompt[\s\S]*assistant: first answer/);
  await plugin.event({ event: { type: "session.idle", properties: { sessionID: "session-1" } } });
  assert.equal(retained.length, 1, "duplicate idle notification with no new messages does not retain again");

  await plugin["chat.message"]({ sessionID: "session-1" }, { parts: [{ type: "text", text: "second prompt" }] });
  assert.deepEqual(recalls, ["first prompt", "second prompt"]);

  // Compaction replaces the old message IDs; retention must use the new bounded transcript.
  messages = [
    { info: { id: "compact-1", role: "user" }, parts: [{ type: "text", text: "compacted user turn" }] },
    { info: { id: "compact-2", role: "assistant" }, parts: [{ type: "text", text: "compacted assistant turn" }] },
  ];
  await plugin.event({ event: { type: "session.idle", properties: { sessionID: "session-1" } } });
  assert.equal(retained.length, 2);
  assert.match(retained[1], /user: compacted user turn[\s\S]*assistant: compacted assistant turn/);
  assert.equal(retained[1].includes("first prompt"), false);

  // Access policy defaults to device-wide access when the config is absent.
  fs.mkdirSync(path.join(home, ".config", "personal-memory"), { recursive: true });
  let backendCalls = 0;
  let messageCalls = 0;
  globalThis.fetch = async () => { backendCalls += 1; return { ok: true, status: 200, text: async () => "{}" }; };
  const client = { session: { messages: async () => { messageCalls += 1; return { data: [] }; } } };
  for (const config of [
    { optInOnly: true, optInPaths: ["/tmp/elsewhere"] },
    { disabled: true },
    "not json",
  ]) {
    fs.writeFileSync(path.join(home, ".config", "personal-memory", "coding-agent.json"),
      typeof config === "string" ? config : JSON.stringify(config));
    const denied = await PersonalMemoryPlugin({ client, directory: "/tmp/test-project" });
    await denied["chat.message"]({ sessionID: "denied" }, { parts: [{ type: "text", text: "no call" }] });
    await denied.event({ event: { type: "session.idle", properties: { sessionID: "denied" } } });
  }
  assert.equal(backendCalls, 0, "denied, disabled, and invalid configurations make no backend calls");
  assert.equal(messageCalls, 0, "denied, disabled, and invalid configurations do not read OpenCode messages");

  fs.writeFileSync(path.join(home, ".config", "personal-memory", "coding-agent.json"), JSON.stringify({
    optInOnly: true,
    optInPaths: ["/tmp/test-project"],
    mapPathToBank: { "/tmp/test-project": "mapped-bank" },
  }));
  globalThis.fetch = async (url) => {
    backendCalls += 1;
    assert.match(String(url), /banks\/mapped-bank\//, "configured mapping uses the shared bank resolver");
    return { ok: true, status: 200, text: async () => JSON.stringify({ text: "mapped result", based_on: [] }) };
  };
  const mapped = await PersonalMemoryPlugin({ client, directory: "/tmp/test-project" });
  await mapped["chat.message"]({ sessionID: "mapped" }, { parts: [{ type: "text", text: "mapped prompt" }] });
  assert.equal(backendCalls, 1);

  // P4: the startup banner is a constant system entry, built like the SessionStart hook banner.
  const bannerSystem = [];
  await mapped["experimental.chat.system.transform"]({ sessionID: "mapped" }, { system: bannerSystem });
  assert.equal(bannerSystem.at(-1), sessionBanner("hindsight", "mapped-bank"));
  const again = [];
  await mapped["experimental.chat.system.transform"]({ sessionID: "other" }, { system: again });
  assert.deepEqual(again, [sessionBanner("hindsight", "mapped-bank")], "banner only, no memory, for a session without a prompt");

  // S6: the session header follows `[context_proxy] enabled`, not the proxy env file.
  const cfg = path.join(home, ".config", "personal-memory");
  fs.writeFileSync(path.join(cfg, "context-proxy.env"), "LITELLM_MASTER_KEY=sk-test\n");
  const headersFor = async () => {
    const p = await PersonalMemoryPlugin({ client, directory: "/tmp/test-project" });
    const output = { headers: {} };
    await p["chat.headers"]({ sessionID: "ses_h" }, output);
    return output.headers;
  };
  assert.deepEqual(await headersFor(), {}, "env file alone sends no header");
  fs.writeFileSync(path.join(cfg, "config.toml"), "[context_proxy]\nenabled = true\n");
  assert.deepEqual(await headersFor(), { "x-openmem-session-id": "ses_h" });
  fs.writeFileSync(path.join(cfg, "config.toml"), "[context_proxy]\nenabled = false\n");
  assert.deepEqual(await headersFor(), {}, "disabled proxy sends no header although the env file remains");
  console.log("all OpenCode plugin lifecycle tests passed");
} finally {
  globalThis.fetch = oldFetch;
  for (const [key, value] of Object.entries({ HOME: oldHome, HINDSIGHT_URL: oldHindsightUrl, MEMORY_PROVIDER: oldMemoryProvider })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
}
