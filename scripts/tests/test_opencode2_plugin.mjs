#!/usr/bin/env node
/**
 * OpenCode 2 plugin (cli/coding-agent/opencode2-plugin/index.js) against a fake plugin context
 * modelled on https://opencode.ai/v2/docs/build/plugins/server/ : session hooks and event subscription. Disposable HOME only; memory HTTP is stubbed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import plugin from "../../cli/coding-agent/opencode2-plugin/index.js";
import { RECALL_CLOSE, RECALL_OPEN, RECALL_PREFACE } from "../../cli/coding-agent/recall-frame.mjs";
import { sessionBanner } from "../../cli/coding-agent/hook-runner.mjs";

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok    ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "pm-opencode2-"));
const project = path.join(home, "work", "demo");
fs.mkdirSync(project, { recursive: true });
const saved = {};
for (const key of ["HOME", "HINDSIGHT_URL", "MEMORY_PROVIDER", "PM_STACK_ROOT"]) saved[key] = process.env[key];
const oldFetch = globalThis.fetch;
Object.assign(process.env, { HOME: home, HINDSIGHT_URL: "http://memory.test", MEMORY_PROVIDER: "hindsight", PM_STACK_ROOT: path.join(home, "stack") });
const bank = "coding-agent::demo";
const calls = [];
let pendingOps = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ url: u, method: init.method || "GET", body });
  const ok = (value) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
  if (u.endsWith("/reflect")) return ok({ text: `reflected: ${body.query}`, based_on: [] });
  if (u.endsWith("/memories/recall")) return ok({ results: [{ text: `recalled: ${body.query}` }] });
  if (u.endsWith("/memories")) return ok({ operation_id: "op-1" });
  const ops = /\/operations\?status=(\w+)&limit=1$/.exec(u);
  if (ops) return ok({ total: ops[1] === "pending" ? pendingOps : 0, operations: [] });
  throw new Error(`unexpected memory request ${init.method} ${u}`);
};

/** Fake OpenCode 2 plugin context: hooks by name, a command editor, a push-driven event stream. */
function fakeContext(directory) {
  const hooks = {};
  const commands = {};
  const prompts = [];
  const queue = [];
  let wake = null;
  let subscribed = null;
  let sessionMessages = [];
  const ctx = {
    app: { version: "2.2.1" },
    location: { directory, project: { id: "prj_1", directory, canonical: directory } },
    options: {},
    session: {
      hook: async (name, callback) => { hooks[name] = callback; return { dispose: async () => {} }; },
      context: async () => sessionMessages,
      prompt: async (input) => { prompts.push(input); return { id: "msg_p" }; },
    },
    command: {
      transform: async (callback) => { callback({ add: (definition) => { commands[definition.name] = definition; } }); return { dispose: async () => {} }; },
    },
    event: {
      subscribe({ types, signal }) {
        subscribed = { types, signal };
        return {
          async *[Symbol.asyncIterator]() {
            while (!signal.aborted) {
              if (!queue.length) await new Promise((resolve) => { wake = resolve; signal.addEventListener("abort", resolve, { once: true }); });
              while (queue.length) yield queue.shift();
            }
          },
        };
      },
    },
  };
  return {
    ctx, hooks, commands, prompts,
    get subscribed() { return subscribed; },
    setMessages: (list) => { sessionMessages = list; },
    emit: (event) => { queue.push(event); wake?.(); },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
const contextEvent = (sessionID, messages) => ({
  sessionID, agent: "build", model: { providerID: "anthropic", id: "claude" },
  system: [{ type: "text", text: "You are OpenCode." }], messages, options: {}, tools: {},
});
const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }] });

try {
  check("default export is a plain { id, setup } definition", plugin.id === "openmem" && typeof plugin.setup === "function");

  // Allowed workspace: prompt recall, system context, retention on idle.
  const oc = fakeContext(project);
  const cleanup = await plugin.setup(oc.ctx);
  check("registers prompt and context hooks only", ["prompt", "context"].every((n) => typeof oc.hooks[n] === "function")
    && !oc.hooks.compaction, Object.keys(oc.hooks).join());
  check("subscribes to idle events", oc.subscribed?.types?.includes("session.status") && !oc.subscribed.types.includes("session.created"));
  check("adds no commands", Object.keys(oc.commands).length === 0);

  await oc.hooks.prompt({ sessionID: "ses_one", messageID: "msg_1", prompt: { text: "how do we deploy?" }, delivery: "steer" });
  check("first prompt uses reflect", calls.some((c) => c.url.endsWith("/reflect") && c.body.query === "how do we deploy?"));
  const first = contextEvent("ses_one", [user("how do we deploy?")]);
  await oc.hooks.context(first);
  check("P4: context hook adds the session banner as the only system part", first.system.length === 2 && first.system[1].type === "text"
    && first.system[1].text === sessionBanner("hindsight", bank), JSON.stringify(first.system));
  const recallPart = first.messages[0]?.content?.[0]?.text || "";
  check("P6: prompt recall is a leading part of the newest user message, not system", recallPart.startsWith(`Personal memory for ${bank}:\n`)
    && /reflected: how do we deploy\?/.test(recallPart) && recallPart.endsWith("\n\n") && first.messages[0].content[1].text === "how do we deploy?"
    && !first.system.some((p) => p.text.includes("reflected")), JSON.stringify(first.messages));
  check("prompt recall framed as untrusted data, outside event.system",
    recallPart.startsWith(`Personal memory for ${bank}:\n${RECALL_PREFACE}\n${RECALL_OPEN}\n`)
    && recallPart.endsWith(`\n${RECALL_CLOSE}\n\n`) && recallPart.includes("reflected: how do we deploy?")
    && !first.system.some((p) => p.text.includes(RECALL_OPEN)), recallPart);
  // Later requests in the same session: the recalled turn renders byte-identical, the system prefix is unchanged.
  const followUp = contextEvent("ses_one", [user("how do we deploy?"), assistant("with compose")]);
  await oc.hooks.context(followUp);
  check("P6: recalled turn and system are byte-identical on the next request",
    JSON.stringify(followUp.messages[0]) === JSON.stringify(first.messages[0]) && JSON.stringify(followUp.system) === JSON.stringify(first.system)
    && followUp.messages[1].content.length === 1);

  oc.setMessages([
    { id: "msg_1", type: "user", text: "how do we deploy?", time: { created: 1 } },
    { id: "msg_2", type: "assistant", agent: "build", content: [{ type: "reasoning", text: "hidden" }, { type: "text", text: "with compose" }], time: { created: 2 } },
  ]);
  oc.emit({ id: "evt_3", type: "session.status", data: { sessionID: "ses_one", status: { type: "idle" } } });
  oc.emit({ id: "evt_4", type: "session.idle", data: { sessionID: "ses_one" } });
  await settle();
  const retained = calls.filter((c) => c.url.endsWith("/memories") && c.method === "POST");
  check("idle retains the new turn once", retained.length === 1 && /user: how do we deploy\?\n\nassistant: with compose/.test(retained[0].body.items[0].content) && !retained[0].body.items[0].content.includes("hidden"), JSON.stringify(retained.map((r) => r.body)));

  await oc.hooks.prompt({ sessionID: "ses_one", messageID: "msg_3", prompt: { text: "and rollback?" }, delivery: "steer" });
  check("later prompts use recall", calls.some((c) => c.url.endsWith("/memories/recall") && c.body.query === "and rollback?"));
  const second = contextEvent("ses_one", [user("how do we deploy?"), assistant("with compose"), user("and rollback?")]);
  await oc.hooks.context(second);
  check("P6: new recall attaches to the new user message only; the older turn keeps its bytes",
    JSON.stringify(second.messages[0]) === JSON.stringify(first.messages[0])
    && /recalled: and rollback\?/.test(second.messages[2].content[0].text) && second.messages[2].content[1].text === "and rollback?"
    && !second.messages[0].content[0].text.includes("rollback"), JSON.stringify(second.messages));
  oc.setMessages([
    { id: "msg_1", type: "user", text: "how do we deploy?" },
    { id: "msg_2", type: "assistant", content: [{ type: "text", text: "with compose" }] },
    { id: "msg_3", type: "user", text: "and rollback?" },
    { id: "msg_5", type: "assistant", content: [{ type: "text", text: "revert the tag" }] },
  ]);
  check("experimental.idle hook registered", typeof oc.hooks["experimental.idle"] === "function");
  await oc.hooks["experimental.idle"]({ sessionID: "ses_one", background: [] });
  oc.emit({ id: "evt_5", type: "session.execution.succeeded", data: { sessionID: "ses_one" } });
  await settle();
  const retained2 = calls.filter((c) => c.url.endsWith("/memories") && c.method === "POST");
  check("idle hook retains only the new turn, once", retained2.length === 2 && /user: and rollback\?\n\nassistant: revert the tag/.test(retained2[1].body.items[0].content) && !retained2[1].body.items[0].content.includes("deploy"), JSON.stringify(retained2.map((r) => r.body)));
  await oc.hooks.prompt({ sessionID: "ses_three", messageID: "msg_6", prompt: { text: "new session" }, delivery: "steer" });
  oc.setMessages([{ id: "msg_6", type: "user", text: "new session" }, { id: "msg_7", type: "assistant", content: [{ type: "text", text: "hi" }] }]);
  oc.emit({ id: "evt_6", type: "session.execution.succeeded", data: { sessionID: "ses_three" } });
  await settle();
  check("session.execution.succeeded retains", calls.filter((c) => c.url.endsWith("/memories") && c.method === "POST").length === 3);
  check("no session store is written", !fs.existsSync(path.join(home, ".local", "share", "openmem")));

  // Events from another location are ignored.
  oc.setMessages([{ id: "msg_8", type: "user", text: "elsewhere" }, { id: "msg_9", type: "assistant", content: [{ type: "text", text: "x" }] }]);
  await oc.hooks.prompt({ sessionID: "ses_other", messageID: "msg_8", prompt: { text: "elsewhere" }, delivery: "steer" });
  const beforeOther = calls.length;
  oc.emit({ id: "evt_7", type: "session.idle", data: { sessionID: "ses_other", location: { directory: path.join(home, "elsewhere") } } });
  await settle();
  check("idle events of other locations are ignored", calls.length === beforeOther);

  // Fail open: malformed input changes nothing and never throws.
  const bad = { sessionID: "ses_bad", system: [], messages: [null, 3], options: {}, tools: {} };
  let threw = false;
  try { await oc.hooks.context(bad); } catch { threw = true; }
  check("malformed requests fail open", !threw && bad.messages.length === 2);

  cleanup();
  await settle();
  check("cleanup aborts the event stream", oc.subscribed.signal.aborted);

  // Denied workspace: no hooks, no subscription, no memory calls.
  const cfgDir = path.join(home, ".config", "personal-memory");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "coding-agent.json"), JSON.stringify({ disabled: true }));
  const denied = fakeContext(project);
  const deniedCalls = calls.length;
  const deniedCleanup = await plugin.setup(denied.ctx);
  check("denied: no hooks and no subscription", Object.keys(denied.hooks).length === 0 && !denied.subscribed && calls.length === deniedCalls);
  deniedCleanup();

} finally {
  globalThis.fetch = oldFetch;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log("all OpenCode 2 plugin tests passed");
