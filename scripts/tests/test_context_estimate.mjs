#!/usr/bin/env node
/**
 * Trim estimate calibrated from reported usage: Python/JS parity of estimate_prompt_tokens / record_usage
 * (fallback ratio included), trimContext and recordPromptUsage, and the config.toml key.
 * Disposable state only.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CHARS_PER_TOKEN, estimatePromptTokens, fingerprint, promptTokensFromOpenCode, recordPromptUsage, recordUsage,
  recordStepUsage, requestChars, TRIM_KEPT, TRIM_NEW, TRIM_NONE, trimContext, trimSettings, usageCountsFromOpenCode,
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
  {
    const env = contextTrimEnvFromPmConfig({ context_store: { embedding_timeout_s: 90.5, embedding_max_chars: 2000 } });
    const s = trimSettings(env, "/h");
    check("[context_store] embedding_timeout_s / embedding_max_chars reach the trim settings", env.CONTEXT_EMBEDDING_TIMEOUT_S === "90.5"
      && env.CONTEXT_EMBEDDING_MAX_CHARS === "2000" && s.embeddingTimeoutS === 90.5 && s.embeddingMaxChars === 2000, JSON.stringify(env));
    const bad = trimSettings(contextTrimEnvFromPmConfig({ context_store: { embedding_timeout_s: 0, embedding_max_chars: "x" } }), "/h");
    check("invalid embedding settings fall back", bad.embeddingTimeoutS === 30 && bad.embeddingMaxChars === 4000);
  }
  check("[context_proxy] trim_to_fraction maps to the env var and the trim settings",
    contextTrimEnvFromPmConfig({ context_proxy: { trim_to_fraction: 0.4 } }).CONTEXT_TRIM_TO_FRACTION === "0.4"
    && trimSettings(contextTrimEnvFromPmConfig({ context_proxy: { trim_to_fraction: 0.4 } }), "/h").trimToFraction === 0.4);
  check("invalid trim_to_fraction is left out", ["0.4", 0, 1, -0.1, 1.5, true].every((v) => !("CONTEXT_TRIM_TO_FRACTION" in contextTrimEnvFromPmConfig({ context_proxy: { trim_to_fraction: v } }))));
  check("invalid chars_per_token is left out",["2.3", 0, -1, true].every((v) => !("CONTEXT_CHARS_PER_TOKEN" in contextTrimEnvFromPmConfig({ context_proxy: { chars_per_token: v } }))));
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

  // Usage event counts from OpenCode's TokenUsage; trim state passed through measured.
  {
    check("usage counts map input, cache read/write, output", JSON.stringify(usageCountsFromOpenCode({ input: 5, output: 7, reasoning: 2,
      cache: { read: 100, write: 0 } })) === JSON.stringify({ input_tokens: 5, cache_read_tokens: 100, cache_creation_tokens: 0, output_tokens: 7 }));
    check("usage counts leave missing fields null", JSON.stringify(usageCountsFromOpenCode({ input: 5 }))
      === JSON.stringify({ input_tokens: 5, cache_read_tokens: null, cache_creation_tokens: null, output_tokens: null }));
    const marks = [];
    const msgs = history(4);
    await run("ses_tr", msgs, { trimAtTokens: 1 }, { measured: (m) => marks.push(m.trimmed) });
    await run("ses_tr", msgs, { trimAtTokens: 10 ** 9 }, { measured: (m) => marks.push(m.trimmed) });
    await run("ses_tr2", msgs, { trimAtTokens: 10 ** 9 }, { measured: (m) => marks.push(m.trimmed) });
    check("measured carries new cut, kept cut, none", JSON.stringify(marks) === JSON.stringify([TRIM_NEW, TRIM_KEPT, TRIM_NONE]), JSON.stringify(marks));
    check("recordStepUsage needs a measured request", !recordStepUsage(settingsFor(), "ses_tr", null, {}));
  }
} finally {
  fs.rmSync(state, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log("all context estimate tests passed");
