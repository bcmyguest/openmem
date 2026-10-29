#!/usr/bin/env node
/**
 * Parity between the context proxy core (proxy/openmem_context, python3, Chat adapter) and its JS port
 * (cli/coding-agent/context-trim.mjs, OpenCode 2 parts). The same fixture requests
 * (scripts/tests/fixtures/context-parity.json) run through both; rendered views (pointer, pinned first
 * user turn, cut, compressed text), handoff log rows and blob files must match, and both sides must produce
 * the fixture's golden standing instruction and pointer text. Disposable state only.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeSessionId } from "../../cli/coding-agent/context-store.mjs";
import { STANDING_INSTRUCTION, addStandingInstruction, pointerText, trimContext, trimSettings } from "../../cli/coding-agent/context-trim.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/tests/fixtures/context-parity.json"), "utf8"));
const BIG = 10 ** 9;
const TS = "2026-01-01T00:00:00Z";
// Runs each case's requests through process_request; prints the rewritten Chat messages per request.
const PY_DRIVER = `
import json, sys
sys.path.insert(0, sys.argv[1])
from pathlib import Path
from openmem_context import Settings, core, process_request
from openmem_context.core import STANDING_INSTRUCTION, pointer_text
from openmem_context.store import sanitize_sid
core._utc_now = lambda: ${JSON.stringify(TS)}
job = json.loads(sys.stdin.buffer.read().decode("utf-8"))
ctx = Path(job["state"]) / "context"
def no_http(*args):
    raise AssertionError("no registration, so no recall")
ptr = job["pointer"]
out = {"standing": STANDING_INSTRUCTION, "pointer": pointer_text(ptr["sid"], ptr["dropped"], ptr["log_path"]), "views": []}
for case in job["cases"]:
    views = []
    for req in case["requests"]:
        if req.get("force"):
            (ctx / "sessions").mkdir(parents=True, exist_ok=True)
            (ctx / "sessions" / (sanitize_sid(case["sid"]) + ".force")).write_text("")
        data = {"messages": req["messages"], "proxy_server_request": {"headers": {"x-openmem-session-id": case["sid"]}}}
        settings = Settings(trim_at_tokens=req["trim_at"], compress_over_tokens=case["compress"], context_dir=ctx)
        views.append(process_request(data, "acompletion", settings, http=no_http)["messages"])
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
        ...(m.reasoning ? [{ type: "reasoning", text: m.reasoning }] : []),
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
    } else if (p.type === "reasoning") segments.push(`reasoning:${p.text}`);
    else if (p.type === "tool-call") segments.push(`call:${p.id}:${p.name}`);
    else if (p.type === "tool-result") segments.push(`result:${p.id}:${p.result.value}`);
  }
  return [m.role, ...segments];
}

function normalizeChat(m) {
  if (m.role === "tool") return ["tool", `result:${m.tool_call_id}:${m.content}`];
  const segments = [];
  if (m.reasoning_content) segments.push(`reasoning:${m.reasoning_content}`);
  if (m.content) segments.push(`text:${m.content}`);
  for (const c of m.tool_calls || []) segments.push(`call:${c.id}:${c.function.name}`);
  return [m.role, ...segments];
}

function storeSnapshot(state, sid) {
  const ctx = path.join(state, "context");
  const log = path.join(ctx, "sessions", `${sanitizeSessionId(sid)}.log.jsonl`);
  const blobs = path.join(ctx, "blobs");
  return {
    log: fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [],
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
    cases: cases.map((c) => ({ sid: c.sid, compress: c.compress, requests: c.requests.map((r) => ({ force: Boolean(r.force), trim_at: r.trim_at, messages: r.history.map(toChat) })) })),
  };
  const py = spawnSync("python3", ["-c", PY_DRIVER, path.join(ROOT, "proxy")], {
    input: JSON.stringify(job), encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  check("python driver ran", py.status === 0, py.stderr || py.error?.message);
  const pyOut = py.status === 0 ? JSON.parse(py.stdout) : { views: [] };
  const { sid: psid, dropped, log_path: logPath, text: pointerGolden } = FIXTURE.pointer;
  check("golden standing instruction on both sides", pyOut.standing === FIXTURE.standing_instruction && STANDING_INSTRUCTION === FIXTURE.standing_instruction);
  check("golden pointer text on both sides", pyOut.pointer === pointerGolden && pointerText(psid, dropped, logPath) === pointerGolden);
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
    for (const [ri, r] of c.requests.entries()) {
      if (r.force) {
        fs.mkdirSync(sessions, { recursive: true });
        fs.writeFileSync(path.join(sessions, `${sanitizeSessionId(c.sid)}.force`), "");
      }
      const settings = { ...trimSettings({ OPENMEM_STATE_DIR: jsState }, jsState), trimAtTokens: r.trim_at, compressOverTokens: c.compress };
      const view = await trimContext({ sessionID: c.sid, messages: r.history.map(toOpenCode) }, settings, { now: () => new Date(TS) });
      const js = scrub(view.map(normalizeOpenCode), jsState);
      const pyv = scrub((pyViews[ci]?.[ri] || []).map(normalizeChat), pyState);
      check(`${c.name} #${ri}: same view`, JSON.stringify(js) === JSON.stringify(pyv), `\n  js: ${JSON.stringify(js)}\n  py: ${JSON.stringify(pyv)}`);
    }
    const js = scrub(storeSnapshot(jsState, c.sid), jsState);
    const pyv = scrub(storeSnapshot(pyState, c.sid), pyState);
    check(`${c.name}: same log rows`, JSON.stringify(js.log) === JSON.stringify(pyv.log), `\n  js: ${JSON.stringify(js.log)}\n  py: ${JSON.stringify(pyv.log)}`);
  }
  // Blobs are shared by every session, so compare them once after all cases.
  const jsBlobs = storeSnapshot(jsState, "any").blobs;
  const pyBlobs = storeSnapshot(pyState, "any").blobs;
  check("same blob files", JSON.stringify(jsBlobs) === JSON.stringify(pyBlobs), `js ${Object.keys(jsBlobs)} py ${Object.keys(pyBlobs)}`);
  const sidCase = cases.find((c) => c.name.startsWith("session id"));
  check("sanitized id used for files on both sides", fs.existsSync(path.join(pyState, "context", "sessions", "ses___x_.log.jsonl"))
    && fs.existsSync(path.join(sessions, "ses___x_.log.jsonl")) && sanitizeSessionId(sidCase.sid) === "ses___x_");
  check("fixture exercised a compressed result and a pinned first turn",
    Object.keys(storeSnapshot(jsState, "ses_blob").blobs).length === 1
    && storeSnapshot(jsState, "ses_basic").log.length > 5 && storeSnapshot(jsState, "ses_basic").log.every((row) => !row.text.includes("TASK")));
} finally {
  fs.rmSync(pyState, { recursive: true, force: true });
  fs.rmSync(jsState, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log("all context parity tests passed");
