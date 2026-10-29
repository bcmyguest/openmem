#!/usr/bin/env node
/**
 * Native trim core for OpenCode 2 (cli/coding-agent/context-trim.mjs): compression parity with the
 * proxy, cut choice, call/result pair safety, sticky byte identity, .force, log rows, recall note,
 * and the compaction summary. Disposable state directory only.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_COMPACTION_MAX_CHARS,
  DEFAULT_COMPRESS_OVER_TOKENS,
  DEFAULT_TRIM_AT_TOKENS,
  compactionSummary,
  compressText,
  pendingText,
  pointerText,
  trimContext,
  trimSettings,
} from "../../cli/coding-agent/context-trim.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok    ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

const state = fs.mkdtempSync(path.join(os.tmpdir(), "pm-context-trim-"));
const settingsFor = (over = {}) => ({ ...trimSettings({ OPENMEM_STATE_DIR: state }, state), ...over });
const sessions = path.join(state, "context", "sessions");
const read = (file) => fs.readFileSync(file, "utf8");
const logLines = (sid) => {
  const file = path.join(sessions, `${sid}.log.jsonl`);
  return fs.existsSync(file) ? read(file).trim().split("\n") : [];
};
const mode = (file) => fs.statSync(file).mode & 0o777;
const ptr = (sid, dropped) => pointerText(sid, dropped, path.join(sessions, `${sid}.log.jsonl`));

const sys = { role: "system", content: [{ type: "text", text: "instructions update" }] };
const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }] });
const call = (id, name, input) => ({ role: "assistant", content: [{ type: "reasoning", text: `thinking about ${id}` }, { type: "tool-call", id, name, input }] });
const result = (id, name, value) => ({ role: "tool", content: [{ type: "tool-result", id, name, result: { type: "text", value } }] });

// Settings mirror the proxy's environment variables and defaults.
{
  const d = trimSettings({}, "/h");
  check("defaults match the proxy", d.enabled && d.trimAtTokens === DEFAULT_TRIM_AT_TOKENS && DEFAULT_TRIM_AT_TOKENS === 120000
    && d.compressOverTokens === DEFAULT_COMPRESS_OVER_TOKENS && DEFAULT_COMPRESS_OVER_TOKENS === 4000
    && d.compactionMaxChars === DEFAULT_COMPACTION_MAX_CHARS && DEFAULT_COMPACTION_MAX_CHARS === 12000
    && d.contextDir === "/h/.local/share/openmem/context");
  const e = trimSettings({ CONTEXT_PROXY_ENABLED: "off", CONTEXT_TRIM_AT_TOKENS: "50", CONTEXT_COMPRESS_OVER_TOKENS: "x", CONTEXT_COMPACTION_MAX_CHARS: "99", OPENMEM_STATE_DIR: "/s" }, "/h");
  check("env overrides; bad values fall back", !e.enabled && e.trimAtTokens === 50 && e.compressOverTokens === 4000 && e.compactionMaxChars === 99 && e.contextDir === "/s/context");
}

// Compression is a pure function of content and threshold and matches the proxy byte for byte.
{
  const lines = Array.from({ length: 300 }, (_, i) => `line ${i} ${"x".repeat(80)} é 😀`);
  const cases = [lines.join("\n"), "y".repeat(30000), `${"z".repeat(20000)}\n${"w".repeat(100)}`];
  for (const [i, text] of cases.entries()) {
    const a = compressText(text, 4000);
    const b = compressText(text, 4000);
    check(`compression ${i} is deterministic`, a && b && a.compressed === b.compressed && a.id === b.id);
    check(`compression ${i} id is sha256[:16]`, a.id === crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16));
    const py = spawnSync("python3", ["-c", [
      "import sys, json",
      `sys.path.insert(0, ${JSON.stringify(path.join(ROOT, "proxy"))})`,
      "from openmem_context.compress import compress_text",
      "text = sys.stdin.buffer.read().decode('utf-8')",
      "r = compress_text(text, 4000)",
      "sys.stdout.buffer.write(json.dumps(r).encode('utf-8'))",
    ].join("\n")], { input: text, encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    const expected = py.status === 0 ? JSON.parse(py.stdout) : null;
    check(`compression ${i} equals proxy compress_text`, expected && expected[0] === a.compressed && expected[1] === a.id, py.stderr);
  }
  check("small results are not compressed", compressText("short", 4000) === null);
  check("threshold 0 disables compression", compressText("y".repeat(30000), 0) === null);
  check("compressed text is not recompressed", compressText(compressText("y".repeat(30000), 4000).compressed + "y".repeat(30000), 4000) === null);
}

// Below the threshold nothing changes; above it, the in-flight turn is kept and earlier messages drop.
{
  const sid = "ses_basic";
  const messages = [user("first question"), call("c1", "bash", { command: "ls" }), result("c1", "bash", "a\nb"), assistant("done"), sys, user("second question")];
  const untouched = await trimContext({ sessionID: sid, system: [], tools: {}, messages }, settingsFor());
  check("under threshold returns the same array", untouched === messages);
  check("under threshold writes no log", logLines(sid).length === 0);

  const view = await trimContext({ sessionID: sid, system: [{ type: "text", text: "sys" }], tools: {}, messages }, settingsFor({ trimAtTokens: 1 }));
  check("trim keeps the first user turn, pinned system messages and the last user turn, in order",
    view.length === 3 && view[0] === messages[0] && view[1] === sys && view[2].role === "user");
  check("pointer leads the kept turn", view[2].content[0].text === `${ptr(sid, 3)}\n\n` && view[2].content[1].text === "second question");
  check("pointer text follows the contract",
    view[2].content[0].text === `[openmem: continuing session ${sid}; 3 earlier messages trimmed. Use smart_compact_search(session_id="${sid}", query=...) for anything earlier; the handoff log is ${path.join(sessions, `${sid}.log.jsonl`)} (JSONL, one row per block).]\n\n`);
  check("input messages are not mutated", messages[5].content.length === 1);

  const rows = logLines(sid);
  const parsed = rows.map((line) => JSON.parse(line));
  check("one row per dropped part", parsed.length === 4, rows.join("\n"));
  check("pinned first user turn is not logged", !parsed.some((r) => r.text === "first question"));
  check("seq starts at 0 and is monotonic", parsed.every((r, i) => r.seq === i));
  check("row field order and python separators", rows[0].startsWith('{"seq": 0, "ts": "') && /"role": "assistant", "kind": "thinking", "name": null, "text": "thinking about c1"}$/.test(rows[0]), rows[0]);
  check("ts is ISO 8601 UTC without millis", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(parsed[0].ts));
  check("reasoning is a thinking row", parsed[0].role === "assistant" && parsed[0].kind === "thinking" && parsed[0].text === "thinking about c1" && parsed[0].name === null);
  check("tool call is compact JSON", parsed[1].kind === "tool_use" && parsed[1].name === "bash" && parsed[1].text === '{"command":"ls"}');
  check("tool result row", parsed[2].role === "tool" && parsed[2].kind === "tool_result" && parsed[2].name === "bash" && parsed[2].text === "a\nb");
  check("pinned system messages are not logged", !parsed.some((r) => r.text === "instructions update"));
  check("session files are private", mode(path.join(sessions, `${sid}.log.jsonl`)) === 0o600 && mode(path.join(sessions, `${sid}.trim.json`)) === 0o600 && mode(sessions) === 0o700);
}

// A cut never separates a tool call from its result.
{
  const sid = "ses_pairs";
  const messages = [
    user("zero"), assistant("a0"), user("one"),
    call("c1", "read", { path: "x" }), user("two (steer)"), result("c1", "read", "content"),
  ];
  const view = await trimContext({ sessionID: sid, messages }, settingsFor({ trimAtTokens: 1 }));
  check("cut skips a turn that would split c1", view.length === 5 && view[0] === messages[0] && view[1].content.at(-1).text === "one", JSON.stringify(view.map((m) => m.role)));
  check("call and result both kept", view.some((m) => m.content.some((p) => p.type === "tool-call" && p.id === "c1")) && view.some((m) => m.content.some((p) => p.type === "tool-result" && p.id === "c1")));
  const single = [user("only"), assistant("reply")];
  check("no earlier turn means no trim", (await trimContext({ sessionID: "ses_single", messages: single }, settingsFor({ trimAtTokens: 1 }))) === single);
}

// The cut is sticky: later requests with the same history render the same bytes; recall runs once per cut.
{
  const sid = "ses_sticky";
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, `${sid}.json`), JSON.stringify({ session_id: sid, bank: "bank-a" }));
  const recalls = [];
  const deps = {
    recall: async (bank, query, maxChars) => { recalls.push({ bank, query, maxChars }); return `memory about ${query} ${"m".repeat(50)}`; },
    pending: async (bank) => bank === "bank-a",
  };
  const history = [user("u1"), assistant("a1"), user("<system-reminder>noise</system-reminder>u2 question")];
  const settings = settingsFor({ trimAtTokens: 1, compactionMaxChars: 40 });
  const first = await trimContext({ sessionID: sid, messages: history }, settings, deps);
  check("first user turn pinned before the pointer", first.length === 2 && first[0] === history[0]);
  const note = first[1].content[0].text.replace(/\n\n$/, "");
  check("recall query strips reminders", recalls.length === 1 && recalls[0].query === "u2 question" && recalls[0].bank === "bank-a" && recalls[0].maxChars === 40);
  check("note: pointer, recall capped at max chars, pending line",
    note === `${ptr(sid, 1)}\n[openmem recall]\n${"memory about u2 question mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm".slice(0, 40)}\n${pendingText(sid)}`, note);

  const later = [...history, call("c9", "bash", { command: "pwd" }), result("c9", "bash", "/tmp")];
  const second = await trimContext({ sessionID: sid, messages: later }, settings, deps);
  check("sticky prefix is byte-identical", JSON.stringify(second.slice(0, first.length)) === JSON.stringify(first));
  check("recall runs once per cut", recalls.length === 1);
  const relaxed = await trimContext({ sessionID: sid, messages: later }, settingsFor({ trimAtTokens: 10 ** 9 }), deps);
  check("sticky cut applies below the threshold too", JSON.stringify(relaxed) === JSON.stringify(second));
  check("sticky render logs nothing new", logLines(sid).length === 1);

  const moved = [...later, user("u3")];
  const third = await trimContext({ sessionID: sid, messages: moved }, settings, deps);
  const rows = logLines(sid).map((l) => JSON.parse(l));
  check("next crossing moves the cut forward, first turn still pinned", third.length === 2 && third[0] === moved[0] && third[1].content[0].text.startsWith(ptr(sid, 4)));
  check("seq continues across trims", rows.map((r) => r.seq).join(",") === "0,1,2,3,4", rows.map((r) => r.seq).join(","));
  check("dropped turn logged without the pointer", rows[1].text.includes("u2 question") && !rows.some((r) => r.text.includes("[openmem: continuing")));
  check("first user turn never logged", !rows.some((r) => r.text === "u1"));
  check("recall for the new cut", recalls.length === 2 && recalls[1].query === "u3");

  const failing = { recall: async () => { throw new Error("down"); }, pending: async () => { throw new Error("down"); } };
  const sid2 = "ses_failopen";
  fs.writeFileSync(path.join(sessions, `${sid2}.json`), JSON.stringify({ session_id: sid2, bank: "bank-b" }));
  const err = process.stderr.write;
  const lines = [];
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
  let view;
  try { view = await trimContext({ sessionID: sid2, messages: history }, settings, failing); } finally { process.stderr.write = err; }
  check("recall failure keeps the pointer only", view[1].content[0].text === `${ptr(sid2, 1)}\n\n`);
  check("failure logs type and location, not content", lines.length === 2 && lines.every((l) => /^openmem-context: fail-open Error at \S+:\d+\n$/.test(l) && !l.includes("down")), lines.join(""));
}

// `.force` trims below the threshold once, then the flag is gone.
{
  const sid = "ses_force";
  const messages = [user("a"), assistant("b"), user("c")];
  check("no force, no trim", (await trimContext({ sessionID: sid, messages }, settingsFor())) === messages);
  const flag = path.join(sessions, `${sid}.force`);
  fs.writeFileSync(flag, "");
  const view = await trimContext({ sessionID: sid, messages }, settingsFor());
  check(".force trims", view.length === 2 && view[1].content[0].text.startsWith("[openmem: continuing session ses_force; 1 earlier"));
  check(".force is cleared after the trim", !fs.existsSync(flag));
  fs.writeFileSync(flag, "");
  const single = [user("only")];
  await trimContext({ sessionID: "ses_force", messages: single }, settingsFor());
  check(".force stays when no cut is possible", fs.existsSync(flag));
}

// Large tool results are compressed in every request, logged by blob, and stored in blobs/.
{
  const sid = "ses_blob";
  const big = Array.from({ length: 400 }, (_, i) => `row ${i} ${"q".repeat(60)}`).join("\n");
  const content = { role: "tool", content: [{ type: "tool-result", id: "c1", name: "grep", result: { type: "content", value: [{ type: "text", text: big }] } }] };
  const messages = [user("search"), call("c1", "grep", { pattern: "q" }), content, assistant("found"), user("next")];
  const plain = await trimContext({ sessionID: sid, messages }, settingsFor());
  const part = plain[2].content[0];
  const { id } = compressText(big, 4000);
  check("content result compressed below threshold", part.result.type === "content" && part.result.value.length === 1 && part.result.value[0].text === compressText(big, 4000).compressed);
  check("blob holds the full text", read(path.join(state, "context", "blobs", `${id}.txt`)) === big);
  const again = await trimContext({ sessionID: sid, messages }, settingsFor());
  check("compressed form is stable across requests", JSON.stringify(again) === JSON.stringify(plain));
  await trimContext({ sessionID: sid, messages }, settingsFor({ trimAtTokens: 1 }));
  const row = logLines(sid).map((l) => JSON.parse(l)).find((r) => r.kind === "tool_result");
  check("log row references the blob", row.text.startsWith(`[blob:${id}]\n`) && row.name === "grep" && !row.text.includes("smart_compact_get"));
  const json = { role: "tool", content: [{ type: "tool-result", id: "c2", name: "x", result: { type: "json", value: { a: "b".repeat(40000) } } }] };
  const out = await trimContext({ sessionID: "ses_json", messages: [user("q"), call("c2", "x", {}), json] }, settingsFor());
  check("json results pass through uncompressed", out[2] === json);
}

// Compaction: log what is not logged yet, then a pointer + recall summary.
{
  const sid = "ses_compact";
  fs.writeFileSync(path.join(sessions, `${sid}.json`), JSON.stringify({ session_id: sid, bank: "bank-c" }));
  const deps = { recall: async (_bank, query) => `recall for ${query}`, pending: async () => false };
  const history = [user("one"), assistant("two"), user("three"), assistant("four")];
  await trimContext({ sessionID: sid, messages: history }, settingsFor({ trimAtTokens: 1 }), deps);
  check("trim logged the first turn except the pinned task", logLines(sid).length === 1);
  const summary = await compactionSummary({ sessionID: sid, messages: [...history, user("five")] }, settingsFor(), deps);
  const rows = logLines(sid).map((l) => JSON.parse(l));
  check("compaction logs the pinned task, then from the sticky cut on", rows.map((r) => r.text).join("|") === "two|one|three|four|five", rows.map((r) => r.text).join("|"));
  check("compaction summary is pointer + recall", summary === `${ptr(sid, 5)}\n[openmem recall]\nrecall for five`, summary);
  const trim = JSON.parse(read(path.join(sessions, `${sid}.trim.json`)));
  check("compaction clears the thread", Object.keys(trim.threads).length === 0 && trim.version === 1);
  check("nothing to compact returns null", (await compactionSummary({ sessionID: sid, messages: [sys] }, settingsFor(), deps)) === null);
  const bare = await compactionSummary({ sessionID: "ses_unregistered", messages: [user("x"), assistant("y")] }, settingsFor(), deps);
  check("unregistered session gets the pointer only", bare === ptr("ses_unregistered", 2));
}

// T1: the first real user turn is pinned verbatim before the pointer and never logged.
{
  const sid = "ses_pin";
  const task = user("TASK: port the parser");
  const history = [sys, task, call("p1", "bash", { command: "ls" }), result("p1", "bash", "x"), assistant("a1"), user("u2")];
  const first = await trimContext({ sessionID: sid, messages: history }, settingsFor({ trimAtTokens: 1 }));
  check("T1: pinned task sits before the pointer turn", first.length === 3 && first[0] === sys && first[1] === task
    && first[2].content[0].text === `${ptr(sid, 3)}\n\n`, JSON.stringify(first.map((m) => m.role)));
  check("T1: task never logged", !logLines(sid).some((l) => l.includes("TASK")));
  const later = [...history, call("p2", "bash", { command: "pwd" }), result("p2", "bash", "/")];
  const second = await trimContext({ sessionID: sid, messages: later }, settingsFor({ trimAtTokens: 10 ** 9 }));
  check("T1: sticky prefix byte-identical", JSON.stringify(second.slice(0, first.length)) === JSON.stringify(first));
  const moved = await trimContext({ sessionID: sid, messages: [...later, user("u3")] }, settingsFor({ trimAtTokens: 1 }));
  check("T1: task still pinned after the cut moves", moved.length === 3 && moved[1] === task && moved[2].content[1].text === "u3");
  check("T1: task still not logged", !logLines(sid).some((l) => l.includes("TASK")));

  const inFlight = [task, call("q1", "bash", {}), result("q1", "bash", "y")];
  check("T1: first user turn in flight leaves the request unchanged",
    (await trimContext({ sessionID: "ses_pin_flight", messages: inFlight }, settingsFor({ trimAtTokens: 1 }))) === inFlight);
  const onlyTask = [task, user("more")];
  check("T1: nothing droppable besides the task means no trim",
    (await trimContext({ sessionID: "ses_pin_none", messages: onlyTask }, settingsFor({ trimAtTokens: 1 }))) === onlyTask);
  const wedge = [task, assistant("a"), user("next"), call("w1", "read", {}), user("steer"), result("w1", "read", "r")];
  const safe = await trimContext({ sessionID: "ses_pin_pairs", messages: wedge }, settingsFor({ trimAtTokens: 1 }));
  check("T1: cut never splits a pair", safe.length === 5 && safe[0] === task && safe[1].content[1].text === "next");
}

// Render-only decoration: not fingerprinted, not logged, applied to every kept message.
{
  const sid = "ses_decorate";
  const tag = (m) => (m.role === "user" ? { ...m, content: [...m.content, { type: "text", text: "[deco]" }] } : m);
  const history = [user("t"), assistant("a"), user("u")];
  const view = await trimContext({ sessionID: sid, messages: history }, settingsFor({ trimAtTokens: 1 }), { decorate: tag });
  check("decorate: pinned and cut turns decorated, pointer first", view[0].content.at(-1).text === "[deco]"
    && view[1].content[0].text.startsWith("[openmem: continuing") && view[1].content.at(-1).text === "[deco]");
  check("decorate: rows carry no decoration", !logLines(sid).some((l) => l.includes("[deco]")));
  const plain = await trimContext({ sessionID: sid, messages: history }, settingsFor());
  check("decorate: sticky cut found without decoration", plain.length === 2 && !JSON.stringify(plain).includes("[deco]"));
  const none = [user("x")];
  check("decorate: untrimmed request is decorated", (await trimContext({ sessionID: "ses_decorate2", messages: none }, settingsFor(), { decorate: tag }))[0].content.at(-1).text === "[deco]");
}

// P9: compaction after the stored cut message vanished does not log earlier rows twice.
{
  const sid = "ses_p9";
  const history = [user("one"), assistant("two"), user("three"), assistant("four")];
  await trimContext({ sessionID: sid, messages: history }, settingsFor({ trimAtTokens: 1 }));
  const before = logLines(sid).map((l) => JSON.parse(l).text);
  const rewritten = [user("one"), assistant("two"), user("three (edited)"), assistant("four"), user("five")];
  await compactionSummary({ sessionID: sid, messages: rewritten }, settingsFor());
  const texts = logLines(sid).map((l) => JSON.parse(l).text);
  check("P9: earlier rows logged once", texts.filter((t) => t === "two").length === 1, texts.join("|"));
  check("P9: rows from the stored cut index on are logged", texts.join("|") === [...before, "one", "three (edited)", "four", "five"].join("|"), texts.join("|"));
}

// Session ids are sanitized; disabled trimming is a no-op.
{
  const messages = [user("a"), assistant("b"), user("c")];
  await trimContext({ sessionID: "ses/../weird id", messages }, settingsFor({ trimAtTokens: 1 }));
  check("session id sanitized for file names", fs.existsSync(path.join(sessions, "ses_.._weird_id.log.jsonl")));
  check("blank session id leaves the request alone", (await trimContext({ sessionID: " \t", messages }, settingsFor({ trimAtTokens: 1 }))) === messages
    && (await compactionSummary({ sessionID: "", messages }, settingsFor())) === null);
  check("disabled settings return input", (await trimContext({ sessionID: "ses_off", messages }, settingsFor({ enabled: false, trimAtTokens: 1 }))) === messages);
}

fs.rmSync(state, { recursive: true, force: true });
if (failed) process.exit(1);
console.log("all context trim tests passed");
