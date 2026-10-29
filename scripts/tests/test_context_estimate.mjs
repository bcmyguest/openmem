#!/usr/bin/env node
/**
 * Trim estimate calibrated from reported usage: Python/JS parity of estimate_prompt_tokens / record_usage
 * (fallback ratio included), trimContext and recordPromptUsage, the OpenCode 2 plugin pairing
 * session.step.ended usage with its context request, and the config.toml key. Disposable state only.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CHARS_PER_TOKEN, estimatePromptTokens, fingerprint, promptTokensFromOpenCode, recordPromptUsage, recordUsage,
  requestChars, trimContext, trimSettings,
} from "../../cli/coding-agent/context-trim.mjs";
import { contextTrimEnvFromPmConfig } from "../../wizard/lib/pm-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// Runs every estimate and record case through the proxy's functions; prints the results as JSON.
const PY_DRIVER = `
import json, sys
sys.path.insert(0, sys.argv[1])
from openmem_context.settings import Settings
from openmem_context.tokens import DEFAULT_CHARS_PER_TOKEN, estimate_prompt_tokens, record_usage
job = json.loads(sys.stdin.read())
estimates = [estimate_prompt_tokens(c["chars"], c["usage"], c["root"], c["ratio"]) for c in job["estimates"]]
records = []
for seq in job["records"]:
    state = {"version": 1, "threads": {}}
    results = [record_usage(state, r["root"], r["chars"], r["tokens"]) for r in seq]
    records.append({"results": results, "state": state})
print(json.dumps({"default": DEFAULT_CHARS_PER_TOKEN, "settings_default": Settings().chars_per_token,
                  "estimates": estimates, "records": records}))
`;

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok    ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

const sample = (chars, tokens) => ({ chars, tokens });
const usageOf = (root, s, last = s) => ({ threads: { [root]: s }, last });
const ESTIMATES = [
  // Fallback ratio: no usage, empty usage, malformed usage, other ratios.
  { chars: 0, usage: null, root: "r", ratio: 2.5 },
  { chars: 1, usage: null, root: "r", ratio: 2.5 },
  { chars: 299999, usage: null, root: "r", ratio: 2.5 },
  { chars: 300000, usage: {}, root: "r", ratio: 2.5 },
  { chars: 300001, usage: { threads: [], last: "x" }, root: "r", ratio: 2.5 },
  { chars: 123457, usage: null, root: "r", ratio: 2.3 },
  { chars: 123457, usage: null, root: "r", ratio: 4 },
  { chars: 5000, usage: { last: sample(0, 4) }, root: "r", ratio: 2.5 },
  { chars: 5000, usage: { last: sample(10, -1) }, root: "r", ratio: 2.5 },
  { chars: 5000, usage: { last: sample(7.5, 3) }, root: "r", ratio: 2.5 },
  // Thread sample plus the character change since.
  { chars: 470000, usage: usageOf("r", sample(460000, 200000)), root: "r", ratio: 2.5 },
  { chars: 460000, usage: usageOf("r", sample(460000, 200000)), root: "r", ratio: 2.5 },
  { chars: 1000, usage: usageOf("r", sample(460000, 200000)), root: "r", ratio: 2.5 },
  { chars: 1000, usage: usageOf("r", sample(90000, 3)), root: "r", ratio: 2.5 },
  { chars: 77777, usage: usageOf("r", sample(33333, 11111)), root: "r", ratio: 2.5 },
  // Another thread: the session's latest ratio, bounded.
  { chars: 99999, usage: usageOf("r", sample(46000, 20000)), root: "other", ratio: 2.5 },
  { chars: 99999, usage: usageOf("r", sample(100, 1000)), root: "other", ratio: 2.5 },
  { chars: 99999, usage: usageOf("r", sample(1000000, 7)), root: "other", ratio: 2.5 },
];
const RECORDS = [
  [{ root: "a", chars: 100, tokens: 40 }, { root: "b", chars: 300, tokens: 100 }, { root: "a", chars: 500, tokens: 210 }],
  [{ root: "a", chars: 0, tokens: 40 }, { root: "a", chars: 10, tokens: 0 }, { root: "a", chars: 1.5, tokens: 1 }],
  Array.from({ length: 40 }, (_, i) => ({ root: `t${String(i).padStart(2, "0")}`, chars: 10 + i, tokens: 5 })),
];

// Parity with the proxy.
{
  const py = spawnSync("python3", ["-c", PY_DRIVER, path.join(ROOT, "proxy")], {
    input: JSON.stringify({ estimates: ESTIMATES, records: RECORDS }), encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  check("python driver ran", py.status === 0, py.stderr || py.error?.message);
  const out = py.status === 0 ? JSON.parse(py.stdout) : { estimates: [], records: [] };
  check("same default ratio (2.5)", out.default === DEFAULT_CHARS_PER_TOKEN && out.settings_default === 2.5
    && trimSettings({}, "/h").charsPerToken === 2.5);
  ESTIMATES.forEach((c, i) => {
    const js = estimatePromptTokens(c.chars, c.usage, c.root, c.ratio);
    check(`estimate #${i} (${c.chars} chars, ${c.usage ? "usage" : "fallback"} ratio ${c.ratio}) matches`, js === out.estimates[i],
      `js ${js} py ${out.estimates[i]}`);
  });
  RECORDS.forEach((seq, i) => {
    const state = { version: 1, threads: {} };
    const results = seq.map((r) => recordUsage(state, r.root, r.chars, r.tokens));
    const js = JSON.stringify({ results, state });
    check(`record sequence #${i} matches`, js === JSON.stringify(out.records[i]), `\n  js: ${js}\n  py: ${JSON.stringify(out.records[i])}`);
  });
}

// Settings and config.toml.
{
  check("CONTEXT_CHARS_PER_TOKEN overrides", trimSettings({ CONTEXT_CHARS_PER_TOKEN: "3.25" }, "/h").charsPerToken === 3.25);
  check("bad CONTEXT_CHARS_PER_TOKEN falls back", ["0", "-2", "x", "Infinity", ""].every((v) => trimSettings({ CONTEXT_CHARS_PER_TOKEN: v }, "/h").charsPerToken === 2.5));
  check("[context_proxy] chars_per_token maps to the env var", contextTrimEnvFromPmConfig({ context_proxy: { chars_per_token: 2.3 } }).CONTEXT_CHARS_PER_TOKEN === "2.3");
  check("invalid chars_per_token is left out", ["2.3", 0, -1, true].every((v) => !("CONTEXT_CHARS_PER_TOKEN" in contextTrimEnvFromPmConfig({ context_proxy: { chars_per_token: v } }))));
  check("OpenCode TokenUsage: input + cache read + cache write", promptTokensFromOpenCode({ input: 12, output: 900, reasoning: 40, cache: { read: 90000, write: 3000 } }) === 93012
    && promptTokensFromOpenCode({ input: 0, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }) === null && promptTokensFromOpenCode(null) === null);
}

const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }] });
const history = (turns) => Array.from({ length: turns }, (_, t) => [user(`question ${t} ${"q".repeat(400)}`), assistant(`answer ${t} ${"a".repeat(400)}`)]).flat();
const SYSTEM = [{ type: "text", text: "You are OpenCode." }];

const state = fs.mkdtempSync(path.join(os.tmpdir(), "pm-estimate-"));
const trimFile = (sid) => path.join(state, "context", "sessions", `${sid}.trim.json`);
const readTrim = (sid) => (fs.existsSync(trimFile(sid)) ? JSON.parse(fs.readFileSync(trimFile(sid), "utf8")) : {});
const settingsFor = (over = {}) => ({ ...trimSettings({ OPENMEM_STATE_DIR: state }, state), compressOverTokens: 0, ...over });
const run = (sid, messages, over, deps = {}) => trimContext({ sessionID: sid, system: SYSTEM, tools: {}, messages }, settingsFor(over), deps);

try {
  // Fallback ratio: trims at ceil(chars / 2.5).
  {
    const msgs = history(4);
    const size = requestChars(SYSTEM, {}, msgs);
    const at = Math.ceil(size / 2.5);
    check("below the fallback estimate: unchanged", (await run("ses_fb", msgs, { trimAtTokens: at + 1 })) === msgs);
    check("at the fallback estimate: trimmed", (await run("ses_fb", msgs, { trimAtTokens: at })).length < msgs.length);
  }

  // Reported usage moves the threshold; it never moves an existing cut.
  {
    const msgs = history(4);
    let seen = null;
    await run("ses_cal", msgs.slice(0, 6), { trimAtTokens: 10 ** 9 }, { measured: (m) => { seen = m; } });
    const size6 = requestChars(SYSTEM, {}, msgs.slice(0, 6));
    check("measured reports the root and request chars", seen?.root === fingerprint(msgs[0]) && seen?.chars === size6, JSON.stringify(seen));
    const real6 = Math.floor(size6 * 4 / 5);
    check("recordPromptUsage stores the sample", await recordPromptUsage(settingsFor(), "ses_cal", seen, real6)
      && JSON.stringify(readTrim("ses_cal").usage) === JSON.stringify({ last: { chars: size6, tokens: real6 }, threads: { [seen.root]: { chars: size6, tokens: real6 } } }),
    JSON.stringify(readTrim("ses_cal")));
    const size8 = requestChars(SYSTEM, {}, msgs);
    const fallback = Math.ceil(size8 / 2.5);
    const calibrated = real6 + Math.ceil((size8 - size6) / (size6 / real6));
    check("calibrated estimate exceeds the fallback here", calibrated > fallback, `${calibrated} vs ${fallback}`);
    const trimmed = await run("ses_cal", msgs, { trimAtTokens: fallback + 1 });
    check("calibrated estimate trims where the fallback would not", trimmed.length < msgs.length
      && trimmed.at(-2).content[0].text.startsWith("[openmem: continuing session ses_cal;"));
    const threads = JSON.stringify(readTrim("ses_cal").threads);
    check("bad usage is ignored", !(await recordPromptUsage(settingsFor(), "ses_cal", seen, 0)) && !(await recordPromptUsage(settingsFor(), "ses_cal", null, 9)));
    await recordPromptUsage(settingsFor(), "ses_cal", { root: seen.root, chars: size8, tokens: 1 }, 10 ** 7);
    check("calibration leaves the stored cut alone", JSON.stringify(readTrim("ses_cal").threads) === threads);
    const again = await run("ses_cal", msgs, { trimAtTokens: 10 ** 9 });
    check("same history renders the same view", JSON.stringify(again) === JSON.stringify(trimmed));
    check("disabled trim records nothing", !(await recordPromptUsage(settingsFor({ enabled: false }), "ses_off", seen, 10)) && !fs.existsSync(trimFile("ses_off")));
  }

  // OpenCode 2 plugin: session.step.ended usage calibrates the session it belongs to.
  {
    const { default: plugin } = await import("../../cli/coding-agent/opencode2-plugin/index.js");
    const home = path.join(state, "home");
    const project = path.join(home, "work", "demo");
    fs.mkdirSync(project, { recursive: true });
    const saved = { HOME: process.env.HOME, OPENMEM_STATE_DIR: process.env.OPENMEM_STATE_DIR, PM_STACK_ROOT: process.env.PM_STACK_ROOT };
    Object.assign(process.env, { HOME: home, OPENMEM_STATE_DIR: state, PM_STACK_ROOT: path.join(home, "stack") });
    const oldFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("no memory requests expected"); };
    const hooks = {};
    const queue = [];
    let wake = null;
    let subscribed = null;
    const ctx = {
      app: { version: "2.2.1" },
      location: { directory: project, project: { id: "prj_1", directory: project, canonical: project } },
      options: {},
      session: { hook: async (name, cb) => { hooks[name] = cb; return { dispose: async () => {} }; }, context: async () => [], prompt: async () => ({}) },
      event: {
        subscribe({ types, signal }) {
          subscribed = types;
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
    const emit = (event) => { queue.push(event); wake?.(); };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
    try {
      const cleanup = await plugin.setup(ctx);
      check("plugin subscribes to step events", subscribed?.includes("session.step.ended") && subscribed.includes("session.step.failed"));
      const event = (messages) => ({ sessionID: "ses_oc", agent: "build", model: { providerID: "anthropic", id: "claude" }, system: [{ type: "text", text: "You are OpenCode." }], messages, options: {}, tools: {} });
      const tokens = (input, read, write) => ({ input, output: 50, reasoning: 0, cache: { read, write } });
      const first = event(history(2));
      await hooks.context(first);
      const second = event(history(3));
      await hooks.context(second);
      // Step 1 failed (no usage); step 2 ended: its usage pairs with the second request, not the first.
      emit({ type: "session.step.failed", data: { sessionID: "ses_oc", assistantMessageID: "m1", error: { message: "x" } } });
      emit({ type: "session.step.ended", data: { sessionID: "ses_oc", assistantMessageID: "m2", finish: "stop", cost: 0, tokens: tokens(10, 900, 90) } });
      await settle();
      const usage = readTrim("ses_oc").usage;
      const root = fingerprint(history(1)[0]);
      // The measured size is the request trimContext saw: system (banner pushed before it), tools, messages.
      check("step usage is stored for the request it belongs to", usage?.last?.tokens === 1000 && usage?.threads?.[root]?.tokens === 1000
        && usage.last.chars === requestChars(second.system.slice(0, 2), {}, history(3)), JSON.stringify(usage));
      emit({ type: "session.step.ended", data: { sessionID: "ses_oc", tokens: tokens(1, 1, 1) } });
      await settle();
      check("a step with no measured request records nothing", readTrim("ses_oc").usage.last.tokens === 1000);
      cleanup();
      await settle();
    } finally {
      globalThis.fetch = oldFetch;
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  }
} finally {
  fs.rmSync(state, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log("all context estimate tests passed");
