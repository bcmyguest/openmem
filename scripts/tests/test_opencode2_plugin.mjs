#!/usr/bin/env node
/**
 * OpenCode 2 plugin (cli/coding-agent/opencode2-plugin/index.js) against a fake plugin context
 * modelled on https://opencode.ai/v2/docs/build/plugins/server/ : session hooks, command transform,
 * event subscription. Disposable HOME only; memory HTTP is stubbed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import plugin from "../../cli/coding-agent/opencode2-plugin/index.js";
import { callContextStoreTool } from "../../cli/mcp/context-store.mjs";
import { RECALL_CLOSE, RECALL_OPEN, RECALL_PREFACE, STANDING_INSTRUCTION, pointerText } from "../../cli/coding-agent/context-trim.mjs";
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
for (const key of ["HOME", "HINDSIGHT_URL", "MEMORY_PROVIDER", "OPENMEM_STATE_DIR", "CONTEXT_TRIM_AT_TOKENS", "CONTEXT_PROXY_ENABLED", "CONTEXT_STANDING_INSTRUCTION", "PM_STACK_ROOT"]) saved[key] = process.env[key];
const oldFetch = globalThis.fetch;
Object.assign(process.env, { HOME: home, HINDSIGHT_URL: "http://memory.test", MEMORY_PROVIDER: "hindsight", PM_STACK_ROOT: path.join(home, "stack") });
delete process.env.OPENMEM_STATE_DIR;
delete process.env.CONTEXT_TRIM_AT_TOKENS;
// Config sets enabled = false in places; CONTEXT_PROXY_ENABLED=1 keeps these tests trimming.
process.env.CONTEXT_PROXY_ENABLED = "1";
delete process.env.CONTEXT_STANDING_INSTRUCTION;

const sessions = path.join(home, ".local", "share", "openmem", "context", "sessions");
const ptr = (sid, dropped) => pointerText(sid, dropped);
/** Two earlier exchanges and a new prompt: a trim drops the first reply and the second prompt. */
const fiveTurns = () => [user("a"), assistant("b"), user("c"), assistant("d"), user("e")];
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

/** Fake OpenCode 2 plugin context: hooks by name, one command editor, a push-driven event stream. */
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

  // Allowed workspace: registration, prompt recall, system context, retention on idle.
  const oc = fakeContext(project);
  const cleanup = await plugin.setup(oc.ctx);
  check("registers prompt, context and compaction hooks", ["prompt", "context", "compaction"].every((n) => typeof oc.hooks[n] === "function"));
  check("subscribes to session events", oc.subscribed?.types?.includes("session.created") && oc.subscribed.types.includes("session.status"));
  check("adds a smart-compact command", typeof oc.commands["smart-compact"]?.execute === "function");

  oc.emit({ id: "evt_1", type: "session.created", data: { sessionID: "ses_one", location: { directory: project }, slug: "s", version: "2" } });
  await settle();
  const registration = JSON.parse(fs.readFileSync(path.join(sessions, "ses_one.json"), "utf8"));
  check("session.created writes the registration", registration.session_id === "ses_one" && registration.agent === "opencode" && registration.cwd === project && typeof registration.bank === "string" && registration.bank.length > 0, JSON.stringify(registration));
  oc.emit({ id: "evt_2", type: "session.created", data: { sessionID: "ses_other", location: { directory: path.join(home, "elsewhere") } } });
  await settle();
  check("sessions of other locations are not registered", !fs.existsSync(path.join(sessions, "ses_other.json")));

  await oc.hooks.prompt({ sessionID: "ses_one", messageID: "msg_1", prompt: { text: "how do we deploy?" }, delivery: "steer" });
  check("first prompt uses reflect", calls.some((c) => c.url.endsWith("/reflect") && c.body.query === "how do we deploy?"));
  const first = contextEvent("ses_one", [user("how do we deploy?")]);
  await oc.hooks.context(first);
  check("P4: context hook adds the session banner as a system part", first.system.length === 3 && first.system[1].type === "text"
    && first.system[1].text === sessionBanner("hindsight", registration.bank));
  check("standing instruction is a system part from the first request", first.system[2].type === "text" && first.system[2].text === STANDING_INSTRUCTION);
  const recallPart = first.messages[0]?.content?.[0]?.text || "";
  check("P6: prompt recall is a leading part of the newest user message, not system", recallPart.startsWith(`Personal memory for ${registration.bank}:\n`)
    && /reflected: how do we deploy\?/.test(recallPart) && recallPart.endsWith("\n\n") && first.messages[0].content[1].text === "how do we deploy?"
    && !first.system.some((p) => p.text.includes("reflected")), JSON.stringify(first.messages));
  check("prompt recall framed as untrusted data, outside event.system",
    recallPart.startsWith(`Personal memory for ${registration.bank}:\n${RECALL_PREFACE}\n${RECALL_OPEN}\n`)
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
  check("first prompt registers a session without session.created", fs.existsSync(path.join(sessions, "ses_three.json")));

  // /smart-compact: typed prompt and registered command both set the flag without recall.
  const before = calls.length;
  await oc.hooks.prompt({ sessionID: "ses_one", messageID: "msg_4", prompt: { text: "/smart-compact" }, delivery: "steer" });
  check("typed /smart-compact writes .force", fs.existsSync(path.join(sessions, "ses_one.force")));
  check("/smart-compact makes no memory call", calls.length === before);
  fs.rmSync(path.join(sessions, "ses_one.force"));
  await oc.commands["smart-compact"].execute({ sessionID: "ses_one", prompt: { text: "" }, delivery: "queue" });
  check("command writes .force", fs.existsSync(path.join(sessions, "ses_one.force")));
  check("command prompts with the marked body", oc.prompts.length === 1 && oc.prompts[0].sessionID === "ses_one" && oc.prompts[0].text.includes("openmem:smart-compact") && oc.prompts[0].delivery === "queue");

  // Forced trim through the context hook: pointer + Hindsight recall + ingest note; MCP tools read the session database.
  pendingOps = 2;
  const history = [user("earlier question"), assistant("earlier answer"), user("middle question"), assistant("middle answer"), user("current question")];
  const forced = contextEvent("ses_one", history);
  await oc.hooks.context(forced);
  const note = forced.messages[2]?.content?.[0]?.text || "";
  check("forced trim keeps the first user turn, the reply before the cut and the in-flight turn", forced.messages.length === 3
    && forced.messages[0] === history[0] && forced.messages[1] === history[3]
    && forced.messages[2].content[1].text === "current question", JSON.stringify(forced.messages));
  check("pointer carries recall and the ingest note", note.startsWith(ptr("ses_one", 2)) && note.includes(`${RECALL_PREFACE}\n${RECALL_OPEN}\nrecalled: current question\n${RECALL_CLOSE}`) && note.includes("memory ingest is still running"), note);
  check(".force consumed", !fs.existsSync(path.join(sessions, "ses_one.force")));
  // The trimmed turn is an assistant reply: role "all" includes it; in_context: false keeps only trimmed rows.
  const found = await callContextStoreTool("smart_compact_search", { query: "earlier answer", session_id: "ses_one", role: "all", in_context: false }, { env: process.env, cwd: project });
  const foundText = JSON.stringify(found);
  check("smart_compact_search finds the trimmed turn", foundText.includes("earlier answer"), foundText.slice(0, 400));

  const repeat = contextEvent("ses_one", [...history, assistant("current answer")]);
  await oc.hooks.context(repeat);
  check("later request renders the same pointer turn", JSON.stringify(repeat.messages.slice(0, 3)) === JSON.stringify(forced.messages));

  // Signed Anthropic reasoning through the context hook: a trim drops it from every kept assistant message except
  // the latest; an untrimmed request keeps it.
  const signed = (id, text) => ({ role: "assistant", content: [{ type: "reasoning", text, providerMetadata: { anthropic: { signature: `S-${id}` } } },
    { type: "tool-call", id, name: "bash", input: {} }] });
  const signedHistory = [user("sig task"), assistant("sig a"), user("sig middle"), assistant("first done"), user("sig next"), signed("k1", "plan"),
    { role: "tool", content: [{ type: "tool-result", id: "k1", name: "bash", result: { type: "text", value: "ok" } }] }, signed("k2", "again")];
  const untrimmedSigned = contextEvent("ses_sig", signedHistory);
  await oc.hooks.context(untrimmedSigned);
  check("signed reasoning: untrimmed request keeps every message as sent", untrimmedSigned.messages.every((m, k) => m === signedHistory[k]));
  fs.writeFileSync(path.join(sessions, "ses_sig.force"), "");
  const trimmedSigned = contextEvent("ses_sig", signedHistory);
  await oc.hooks.context(trimmedSigned);
  const keptReasoning = trimmedSigned.messages.flatMap((m) => (m.role === "assistant" ? m.content.filter((p) => p.type === "reasoning") : []));
  check("signed reasoning: trim keeps only the latest assistant message's signed part",
    trimmedSigned.messages.at(-1) === signedHistory.at(-1) && keptReasoning.length === 1 && keptReasoning[0].text === "again"
    && trimmedSigned.messages.some((m) => m.role === "assistant" && JSON.stringify(m.content) === JSON.stringify([signedHistory[5].content[1]])),
    JSON.stringify(trimmedSigned.messages));

  // Tool-result compression reaches the model request and smart_compact_get returns the full text.
  const big = Array.from({ length: 200 }, (_, i) => `out ${i} ${"v".repeat(100)}`).join("\n");
  const withTool = contextEvent("ses_tool", [
    user("run it"),
    { role: "assistant", content: [{ type: "tool-call", id: "t1", name: "bash", input: { command: "make" } }] },
    { role: "tool", content: [{ type: "tool-result", id: "t1", name: "bash", result: { type: "text", value: big } }] },
  ]);
  await oc.hooks.context(withTool);
  const compressed = withTool.messages[2].content[0].result.value;
  const blob = /smart_compact_get\(id="([0-9a-f]{16})"\)/.exec(compressed)?.[1];
  check("large tool result compressed in the request", compressed.startsWith("[openmem: tool result compressed,") && Boolean(blob));
  const full = await callContextStoreTool("smart_compact_get", { id: blob }, { env: process.env });
  check("smart_compact_get returns the full result", JSON.stringify(full).includes("out 199"));

  // Native compaction: summary replaces the model call.
  const compaction = contextEvent("ses_one", [...history, assistant("current answer"), user("compact now")]);
  await oc.hooks.compaction(compaction);
  check("compaction hook sets the result", compaction.result?.summary?.startsWith(ptr("ses_one", 7)) && compaction.result.summary.includes(`${RECALL_PREFACE}\n${RECALL_OPEN}\nrecalled: compact now\n${RECALL_CLOSE}`), JSON.stringify(compaction.result));

  // Fail open: malformed input changes nothing and never throws.
  const bad = { sessionID: "ses_bad", system: [], messages: [null, 3], options: {}, tools: {} };
  let threw = false;
  try { await oc.hooks.context(bad); await oc.hooks.compaction(bad); } catch { threw = true; }
  check("malformed requests fail open", !threw && bad.messages.length === 2 && bad.result === undefined);

  cleanup();
  await settle();
  check("cleanup aborts the event stream", oc.subscribed.signal.aborted);

  // [compaction] native = false leaves compaction to OpenCode; trimming still runs.
  const cfgDir = path.join(home, ".config", "personal-memory");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "config.toml"), "[compaction]\nnative = false\n");
  const off = fakeContext(project);
  const offCleanup = await plugin.setup(off.ctx);
  const leftAlone = contextEvent("ses_two", [user("a"), assistant("b"), user("c")]);
  await off.hooks.compaction(leftAlone);
  check("[compaction] native = false skips the result", leftAlone.result === undefined);
  offCleanup();

  // [context_proxy] trim_at_tokens in config.toml reaches the native trim; CONTEXT_TRIM_AT_TOKENS still wins.
  fs.writeFileSync(path.join(cfgDir, "config.toml"), "[context_proxy]\ntrim_at_tokens = 1\n");
  const cfgTrim = fakeContext(project);
  const cfgTrimCleanup = await plugin.setup(cfgTrim.ctx);
  const byConfig = contextEvent("ses_cfg", fiveTurns());
  await cfgTrim.hooks.context(byConfig);
  check("config.toml trim_at_tokens trims", byConfig.messages.length === 3 && byConfig.messages[2].content[0].text.startsWith(ptr("ses_cfg", 2)));
  cfgTrimCleanup();
  process.env.CONTEXT_TRIM_AT_TOKENS = "1000000";
  const envWins = fakeContext(project);
  const envWinsCleanup = await plugin.setup(envWins.ctx);
  const byEnv = contextEvent("ses_cfg_env", fiveTurns());
  await envWins.hooks.context(byEnv);
  check("CONTEXT_TRIM_AT_TOKENS overrides config.toml", byEnv.messages.length === 5);
  envWinsCleanup();
  delete process.env.CONTEXT_TRIM_AT_TOKENS;
  fs.rmSync(path.join(cfgDir, "config.toml"));

  // [context_proxy.agents] opencode2 gates the native trim, falling back to [context_proxy] enabled;
  // CONTEXT_PROXY_ENABLED still overrides.
  delete process.env.CONTEXT_PROXY_ENABLED;
  const trimsWith = async (toml, sid) => {
    if (toml === null) fs.rmSync(path.join(cfgDir, "config.toml"), { force: true });
    else fs.writeFileSync(path.join(cfgDir, "config.toml"), `[context_proxy]\ntrim_at_tokens = 1\n${toml}`);
    const g = fakeContext(project);
    const gCleanup = await plugin.setup(g.ctx);
    const event = contextEvent(sid, fiveTurns());
    await g.hooks.context(event);
    gCleanup();
    return event.messages.length === 3;
  };
  check("per-agent: opencode2 = true trims although enabled = false", await trimsWith("enabled = false\n[context_proxy.agents]\nopencode2 = true\n", "ses_g1"));
  check("per-agent: opencode2 = false does not trim although enabled = true", !(await trimsWith("enabled = true\n[context_proxy.agents]\nopencode2 = false\n", "ses_g2")));
  check("per-agent: a missing opencode2 key follows enabled = true", await trimsWith("enabled = true\n", "ses_g3"));
  check("per-agent: a missing opencode2 key follows enabled = false", !(await trimsWith("enabled = false\n", "ses_g4")));
  check("per-agent: [context_proxy] without enabled or opencode2 trims (default on)", await trimsWith("", "ses_g8"));
  process.env.CONTEXT_TRIM_AT_TOKENS = "1";
  check("per-agent: no config.toml trims (default on)", await trimsWith(null, "ses_g5"));
  delete process.env.CONTEXT_TRIM_AT_TOKENS;
  process.env.CONTEXT_PROXY_ENABLED = "0";
  check("per-agent: CONTEXT_PROXY_ENABLED=0 overrides opencode2 = true", !(await trimsWith("[context_proxy.agents]\nopencode2 = true\n", "ses_g6")));
  process.env.CONTEXT_PROXY_ENABLED = "1";
  check("per-agent: CONTEXT_PROXY_ENABLED=1 overrides opencode2 = false", await trimsWith("[context_proxy.agents]\nopencode2 = false\n", "ses_g7"));
  fs.rmSync(path.join(cfgDir, "config.toml"), { force: true });

  // Denied workspace: no memory calls or registration, but /smart-compact and trimming still work.
  fs.writeFileSync(path.join(cfgDir, "coding-agent.json"), JSON.stringify({ disabled: true }));
  const denied = fakeContext(project);
  const deniedCleanup = await plugin.setup(denied.ctx);
  const deniedCalls = calls.length;
  denied.emit({ id: "evt_9", type: "session.created", data: { sessionID: "ses_denied", location: { directory: project } } });
  await settle();
  await denied.hooks.prompt({ sessionID: "ses_denied", messageID: "m", prompt: { text: "secret question" }, delivery: "steer" });
  const deniedContext = contextEvent("ses_denied", [user("x")]);
  await denied.hooks.context(deniedContext);
  denied.setMessages([{ id: "m", type: "user", text: "secret question" }]);
  denied.emit({ id: "evt_10", type: "session.idle", data: { sessionID: "ses_denied" } });
  await settle();
  check("denied: no memory calls", calls.length === deniedCalls);
  check("denied: no registration, no system memory", !fs.existsSync(path.join(sessions, "ses_denied.json")) && deniedContext.system.length === 2
    && deniedContext.system[1].text === STANDING_INSTRUCTION);
  await denied.hooks.prompt({ sessionID: "ses_denied", messageID: "m2", prompt: { text: "/smart-compact" }, delivery: "steer" });
  check("denied: /smart-compact still writes .force", fs.existsSync(path.join(sessions, "ses_denied.force")));
  const deniedTrim = contextEvent("ses_denied", fiveTurns());
  await denied.hooks.context(deniedTrim);
  check("denied: trim has the pointer and no recall", deniedTrim.messages.length === 3 && deniedTrim.messages[2].content[0].text === `${ptr("ses_denied", 2)}\n\n` && calls.length === deniedCalls);
  deniedCleanup();

  // Standing instruction: not duplicated when present; CONTEXT_STANDING_INSTRUCTION=0 leaves it out.
  const again = contextEvent("ses_denied", [user("x")]);
  again.system.push({ type: "text", text: STANDING_INSTRUCTION });
  const dedupe = fakeContext(project);
  const dedupeCleanup = await plugin.setup(dedupe.ctx);
  await dedupe.hooks.context(again);
  check("standing instruction not duplicated", again.system.filter((p) => p.text === STANDING_INSTRUCTION).length === 1 && again.system.length === 2);
  dedupeCleanup();
  process.env.CONTEXT_STANDING_INSTRUCTION = "0";
  const standingOff = fakeContext(project);
  const standingOffCleanup = await plugin.setup(standingOff.ctx);
  const offContext = contextEvent("ses_denied", [user("x")]);
  await standingOff.hooks.context(offContext);
  check("CONTEXT_STANDING_INSTRUCTION=0 leaves the system prompt alone", offContext.system.length === 1);
  standingOffCleanup();
  delete process.env.CONTEXT_STANDING_INSTRUCTION;
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
