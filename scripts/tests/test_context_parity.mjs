#!/usr/bin/env node
/**
 * Parity between the context proxy core (proxy/openmem_context, python3, Chat adapter) and its JS port
 * (cli/coding-agent/context-trim.mjs, OpenCode 2 parts). The same fixture requests
 * (scripts/tests/fixtures/context-parity.json) run through both; rendered views (pointer, pinned first
 * user turn, cut, compressed text, framed recall), session database rows (messages and lines, every column)
 * and schema, and blob files must match, and both sides must produce the fixture's golden standing
 * instruction, pointer text and recall blocks. Disposable state only.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeSessionId } from "../../cli/coding-agent/context-store.mjs";
import { proxyCodeVersion } from "../../cli/coding-agent/session-db.mjs";
import { STANDING_INSTRUCTION, addStandingInstruction, isSignedReasoning, pointerText, recallBlock, trimContext, trimSettings } from "../../cli/coding-agent/context-trim.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/tests/fixtures/context-parity.json"), "utf8"));
const BIG = 10 ** 9;
const DEFAULT_MAX_CHARS = 12000;
const TS = "2026-01-01T00:00:00Z";
// Runs each case's requests through process_request; prints the rewritten Chat messages per request.
const PY_DRIVER = `
import json, sys
sys.path.insert(0, sys.argv[1])
from pathlib import Path
from openmem_context import Settings, core, process_request
from openmem_context.core import STANDING_INSTRUCTION, pointer_text, recall_block
from openmem_context.store import sanitize_sid
core._utc_now = lambda: ${JSON.stringify(TS)}
job = json.loads(sys.stdin.buffer.read().decode("utf-8"))
ctx = Path(job["state"]) / "context"
def no_http(*args):
    raise AssertionError("no registration, so no recall")
def recall_http(text):
    def http(method, url, body, timeout):
        return 200, ({"results": [{"text": text}]} if url.endswith("/memories/recall") else {"total": 0})
    return http
ptr = job["pointer"]
rec = job["recall"]
out = {"standing": STANDING_INSTRUCTION, "pointer": pointer_text(ptr["sid"], ptr["dropped"]),
       "recall": [recall_block(rec["text"], c["max_chars"]) for c in rec["cases"]], "views": []}
for case in job["cases"]:
    views = []
    http = no_http
    if case.get("bank"):
        (ctx / "sessions").mkdir(parents=True, exist_ok=True)
        (ctx / "sessions" / (sanitize_sid(case["sid"]) + ".json")).write_text(json.dumps({"bank": case["bank"]}))
        http = recall_http(case["recall"])
    for req in case["requests"]:
        if req.get("force"):
            (ctx / "sessions").mkdir(parents=True, exist_ok=True)
            (ctx / "sessions" / (sanitize_sid(case["sid"]) + ".force")).write_text("")
        data = {"messages": req["messages"], "proxy_server_request": {"headers": {"x-openmem-session-id": case["sid"]}}}
        settings = Settings(trim_at_tokens=req["trim_at"], compress_over_tokens=case["compress"], context_dir=ctx)
        views.append(process_request(data, "acompletion", settings, http=http)["messages"])
    out["views"].append(views)
sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False).encode("utf-8"))
`;

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok    ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

const expand = (text) => (typeof text === "string" ? text
  : Array.from({ length: text.count }, (_, i) => text.lines.replaceAll("{i}", String(i))).join("\n"));

function toChat(m) {
  switch (m.role) {
    case "system": return { role: "system", content: m.text };
    case "user": return { role: "user", content: m.text };
    case "tool": return { role: "tool", tool_call_id: m.result.id, name: m.result.name, content: expand(m.result.text) };
    default: {
      const out = { role: "assistant", content: m.text ?? null };
      if (m.reasoning) out.reasoning_content = m.reasoning;
      // LiteLLM's Chat shape for signed Anthropic thinking: thinking_blocks beside the reasoning_content copy.
      if (m.signature) out.thinking_blocks = [{ type: "thinking", thinking: m.reasoning, signature: m.signature }];
      if (m.redacted) out.thinking_blocks = [{ type: "redacted_thinking", data: m.redacted }];
      if (m.calls) out.tool_calls = m.calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) } }));
      return out;
    }
  }
}

function toOpenCode(m) {
  switch (m.role) {
    case "system": return { role: "system", content: [{ type: "text", text: m.text }] };
    case "user": return { role: "user", content: [{ type: "text", text: m.text }] };
    case "tool": return { role: "tool", content: [{ type: "tool-result", id: m.result.id, name: m.result.name, result: { type: "text", value: expand(m.result.text) } }] };
    default: return {
      role: "assistant",
      content: [
        ...(m.reasoning ? [{ type: "reasoning", text: m.reasoning, ...(m.signature ? { providerMetadata: { anthropic: { signature: m.signature } } } : {}) }] : []),
        ...(m.redacted ? [{ type: "reasoning", text: "", providerMetadata: { anthropic: { redactedData: m.redacted } } }] : []),
        ...(m.text ? [{ type: "text", text: m.text }] : []),
        ...(m.calls || []).map((c) => ({ type: "tool-call", id: c.id, name: c.name, input: c.input })),
      ],
    };
  }
}

/** Format-neutral view: role plus segments; consecutive text parts join with "" as OpenCode's lowering does. */
function normalizeOpenCode(m) {
  const segments = [];
  for (const p of m.content) {
    if (p.type === "text") {
      if (segments.at(-1)?.startsWith("text:")) segments[segments.length - 1] += p.text;
      else segments.push(`text:${p.text}`);
    } else if (p.type === "reasoning") segments.push(`reasoning:${p.text}${isSignedReasoning(p) ? ":signed" : ""}`);
    else if (p.type === "tool-call") segments.push(`call:${p.id}:${p.name}`);
    else if (p.type === "tool-result") segments.push(`result:${p.id}:${p.result.value}`);
  }
  return [m.role, ...segments];
}

function normalizeChat(m) {
  if (m.role === "tool") return ["tool", `result:${m.tool_call_id}:${m.content}`];
  const segments = [];
  if (m.thinking_blocks) segments.push(...m.thinking_blocks.map((b) => `reasoning:${b.thinking ?? ""}:signed`));
  else if (m.reasoning_content) segments.push(`reasoning:${m.reasoning_content}`);
  if (m.content) segments.push(`text:${m.content}`);
  for (const c of m.tool_calls || []) segments.push(`call:${c.id}:${c.function.name}`);
  return [m.role, ...segments];
}

function dbRows(file, sql) {
  if (!fs.existsSync(file)) return [];
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare(sql).all().map((r) => ({ ...r })); } finally { db.close(); }
}

function storeSnapshot(state, sid) {
  const ctx = path.join(state, "context");
  const file = path.join(ctx, "sessions", `${sanitizeSessionId(sid)}.db`);
  const blobs = path.join(ctx, "blobs");
  return {
    log: dbRows(file, "SELECT * FROM messages ORDER BY seq"),
    lines: dbRows(file, "SELECT * FROM lines ORDER BY id"),
    schema: dbRows(file, "SELECT type, name, sql FROM sqlite_master ORDER BY name").concat(dbRows(file, "PRAGMA user_version")),
    blobs: fs.existsSync(blobs) ? Object.fromEntries(fs.readdirSync(blobs).sort().map((f) => [f, fs.readFileSync(path.join(blobs, f), "utf8")])) : {},
  };
}

const scrub = (value, state) => JSON.parse(JSON.stringify(value).replaceAll(state, "<STATE>"));

const pyState = fs.mkdtempSync(path.join(os.tmpdir(), "pm-parity-py-"));
const jsState = fs.mkdtempSync(path.join(os.tmpdir(), "pm-parity-js-"));
try {
  // Expand each case into full per-request histories.
  const cases = FIXTURE.cases.map((c) => {
    let history = [];
    const requests = c.requests.map((r) => {
      history = r.messages ? [...r.messages] : [...history, ...(r.append || [])];
      return { ...r, history: [...history], trim_at: r.trim ? 1 : BIG };
    });
    return { ...c, requests };
  });

  const job = {
    state: pyState,
    pointer: FIXTURE.pointer,
    recall: FIXTURE.recall,
    cases: cases.map((c) => ({ sid: c.sid, compress: c.compress, bank: c.bank, recall: c.recall, requests: c.requests.map((r) => ({ force: Boolean(r.force), trim_at: r.trim_at, messages: r.history.map(toChat) })) })),
  };
  const py = spawnSync("python3", ["-c", PY_DRIVER, path.join(ROOT, "proxy")], {
    input: JSON.stringify(job), encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  check("python driver ran", py.status === 0, py.stderr || py.error?.message);
  const pyOut = py.status === 0 ? JSON.parse(py.stdout) : { views: [] };
  const { sid: psid, dropped, text: pointerGolden } = FIXTURE.pointer;
  check("golden standing instruction on both sides", pyOut.standing === FIXTURE.standing_instruction && STANDING_INSTRUCTION === FIXTURE.standing_instruction);
  check("golden pointer text on both sides", pyOut.pointer === pointerGolden && pointerText(psid, dropped) === pointerGolden);
  for (const [i, { max_chars: maxChars, block }] of FIXTURE.recall.cases.entries()) {
    check(`golden recall block at ${maxChars} chars on both sides`, pyOut.recall?.[i] === block && recallBlock(FIXTURE.recall.text, maxChars) === block,
      `\n  js: ${JSON.stringify(recallBlock(FIXTURE.recall.text, maxChars))}\n  py: ${JSON.stringify(pyOut.recall?.[i])}`);
  }
  // The proxy's Chat view carries the instruction as a system message after the leading system messages; the
  // OpenCode 2 plugin puts it in event.system. Check and remove it so the message views compare as before.
  const jsSystem = [];
  addStandingInstruction(jsSystem, trimSettings({}, pyState));
  const standingMessage = { role: "system", content: jsSystem[0]?.text };
  const pyViews = pyOut.views.map((views, ci) => views.map((view, ri) => {
    const at = view.findIndex((m) => m.role !== "system" || m.content === STANDING_INSTRUCTION);
    const ok = at >= 0 && JSON.stringify(view[at]) === JSON.stringify(standingMessage)
      && view.filter((m) => m.content === STANDING_INSTRUCTION).length === 1;
    check(`${FIXTURE.cases[ci].name} #${ri}: one standing instruction after the leading system messages`, ok);
    return ok ? [...view.slice(0, at), ...view.slice(at + 1)] : view;
  }));

  const sessions = path.join(jsState, "context", "sessions");
  for (const [ci, c] of cases.entries()) {
    const deps = { now: () => new Date(TS) };
    if (c.bank) {
      fs.mkdirSync(sessions, { recursive: true });
      fs.writeFileSync(path.join(sessions, `${sanitizeSessionId(c.sid)}.json`), JSON.stringify({ bank: c.bank }));
      Object.assign(deps, { recall: async () => c.recall, pending: async () => false });
    }
    for (const [ri, r] of c.requests.entries()) {
      if (r.force) {
        fs.mkdirSync(sessions, { recursive: true });
        fs.writeFileSync(path.join(sessions, `${sanitizeSessionId(c.sid)}.force`), "");
      }
      const settings = { ...trimSettings({ OPENMEM_STATE_DIR: jsState }, jsState), trimAtTokens: r.trim_at, compressOverTokens: c.compress };
      const view = await trimContext({ sessionID: c.sid, messages: r.history.map(toOpenCode) }, settings, deps);
      const js = scrub(view.map(normalizeOpenCode), jsState);
      const pyv = scrub((pyViews[ci]?.[ri] || []).map(normalizeChat), pyState);
      check(`${c.name} #${ri}: same view`, JSON.stringify(js) === JSON.stringify(pyv), `\n  js: ${JSON.stringify(js)}\n  py: ${JSON.stringify(pyv)}`);
    }
    const js = scrub(storeSnapshot(jsState, c.sid), jsState);
    const pyv = scrub(storeSnapshot(pyState, c.sid), pyState);
    check(`${c.name}: same database rows`, JSON.stringify(js.log) === JSON.stringify(pyv.log), `\n  js: ${JSON.stringify(js.log)}\n  py: ${JSON.stringify(pyv.log)}`);
    check(`${c.name}: same lines rows`, js.lines.length > 0 && JSON.stringify(js.lines) === JSON.stringify(pyv.lines));
    check(`${c.name}: same schema and user_version`, js.schema.length > 0 && JSON.stringify(js.schema) === JSON.stringify(pyv.schema), `\n  js: ${JSON.stringify(js.schema)}\n  py: ${JSON.stringify(pyv.schema)}`);
  }
  // Blobs are shared by every session, so compare them once after all cases.
  const jsBlobs = storeSnapshot(jsState, "any").blobs;
  const pyBlobs = storeSnapshot(pyState, "any").blobs;
  check("same blob files", JSON.stringify(jsBlobs) === JSON.stringify(pyBlobs), `js ${Object.keys(jsBlobs)} py ${Object.keys(pyBlobs)}`);
  const sidCase = cases.find((c) => c.name.startsWith("session id"));
  check("sanitized id used for files on both sides", fs.existsSync(path.join(pyState, "context", "sessions", "ses___x_.db"))
    && fs.existsSync(path.join(sessions, "ses___x_.db")) && sanitizeSessionId(sidCase.sid) === "ses___x_");
  const gapViews = pyViews[cases.findIndex((c) => c.sid === "ses_gap")] || [];
  // Noted task + the last three exchanges (seven messages), sticky, then the gap moves forward by one exchange.
  check("gap case: cut inside the turn keeps three exchanges, then the gap grows",
    JSON.stringify(gapViews.map((v) => v.length)) === "[8,10,8]", JSON.stringify(gapViews.map((v) => v.length)));
  const recallCase = cases.find((c) => c.bank);
  const recallViews = pyOut.views[cases.indexOf(recallCase)] || [];
  const framed = recallBlock(recallCase.recall, DEFAULT_MAX_CHARS);
  check("recall case: framed block in the note, reused byte for byte by the next request",
    recallViews.length === 2 && JSON.stringify(recallViews[0]).includes(JSON.stringify(framed).slice(1, -1))
    && JSON.stringify(recallViews[1].slice(0, recallViews[0].length)) === JSON.stringify(recallViews[0]));
  const thinkingViews = pyOut.views[cases.findIndex((c) => c.sid === "ses_thinking")] || [];
  const signed = (view) => view.filter((m) => m.thinking_blocks).map((m) => m.thinking_blocks[0].signature);
  // Only the latest assistant message keeps its signature; the redacted-only reply before the cut is dropped.
  check("thinking case: only the latest assistant message keeps signed thinking, on the sticky re-render too",
    JSON.stringify(thinkingViews.map(signed)) === '[["SIG3"],["SIG4"]]'
    && !thinkingViews.flat().some((m) => m.thinking_blocks?.[0]?.type === "redacted_thinking"), JSON.stringify(thinkingViews.map(signed)));
  const basic = storeSnapshot(jsState, "ses_basic").log;
  check("fixture exercised a compressed result, trimmed rows and a pinned first turn",
    Object.keys(storeSnapshot(jsState, "ses_blob").blobs).length === 1
    && storeSnapshot(jsState, "ses_blob").log.some((row) => row.blob_id)
    && basic.filter((row) => row.in_context === 0).length > 5
    && basic.filter((row) => row.text.includes("TASK")).every((row) => row.in_context === 1));
} finally {
  fs.rmSync(pyState, { recursive: true, force: true });
  fs.rmSync(jsState, { recursive: true, force: true });
}

{
  const py = spawnSync("python3", ["-c", "import sys; sys.path.insert(0, sys.argv[1]); from openmem_context import core; print(core.VERSION)",
    path.join(ROOT, "proxy")], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  const js = proxyCodeVersion(path.join(ROOT, "proxy", "openmem_context"));
  check("proxy code version: JS hash matches the proxy's own", py.status === 0 && py.stdout.trim() === js, `py ${py.stdout.trim()} js ${js}`);
}

if (failed) process.exit(1);
console.log("all context parity tests passed");
