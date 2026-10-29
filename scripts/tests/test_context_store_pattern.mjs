#!/usr/bin/env node
// smart_compact_search pattern/context params, exactly-one-of validation, regex guard, log_files.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { callContextStoreTool, CONTEXT_STORE_MCP_TOOLS } from "../../cli/mcp/context-store.mjs";

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok    ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}
function throws(fn, re) {
  try {
    fn();
    return false;
  } catch (err) {
    return re.test(String(err?.message));
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openmem-ctx-pat-"));
const state = path.join(tmp, "state");
const sessions = path.join(state, "context", "sessions");
fs.mkdirSync(sessions, { recursive: true });
const repo = path.join(tmp, "repo");
fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
const ENV = { OPENMEM_STATE_DIR: state, HOME: tmp };

const row = (seq, text, extra = {}) => ({ seq, ts: "2026-10-29T17:00:00Z", role: "assistant", kind: "text", name: null, text, ...extra });
function log(sid, rows) {
  fs.writeFileSync(path.join(sessions, `${sid}.log.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}
fs.writeFileSync(
  path.join(sessions, "s1.json"),
  JSON.stringify({ session_id: "s1", agent: "claude-code", cwd: repo, bank: "b", registered_at: "2026-10-29T10:00:00Z" }),
);
// Written out of seq order: neighbours must follow seq, not file order.
log("s1", [
  row(3, "step three"),
  row(0, "step zero"),
  row(1, "step one"),
  row(2, "Error: ECONNREFUSED 127.0.0.1:4100"),
  row(5, "step five"),
  row(4, "error: timeout after 30s"),
]);

const search = (args) => callContextStoreTool("smart_compact_search", args, { env: ENV, cwd: repo });

{
  const tool = CONTEXT_STORE_MCP_TOOLS.find((t) => t.name === "smart_compact_search");
  const props = tool.inputSchema.properties;
  check("schema exposes pattern, ignore_case, context", Boolean(props.pattern && props.ignore_case && props.context));
  check("schema no longer requires query", !(tool.inputSchema.required || []).includes("query"));
}

{
  const r = search({ pattern: "ECONNREFUSED \\d+\\.\\d+\\.\\d+\\.\\d+:\\d+", session_id: "s1" });
  check("regex finds the matching row", r.results.length === 1 && r.results[0].seq === 2, JSON.stringify(r.results));
  check(
    "pattern echoed, no query or matched_terms",
    r.pattern?.startsWith("ECONNREFUSED") && r.query === undefined && r.results[0].matched_terms === undefined,
  );
  check("no context key without context", r.results[0].before === undefined && r.results[0].after === undefined);
}

{
  const sensitive = search({ pattern: "^error:", session_id: "s1" });
  check("pattern is case-sensitive by default", sensitive.results.map((x) => x.seq).join(",") === "4", JSON.stringify(sensitive.results));
  const insensitive = search({ pattern: "^error:", ignore_case: true, session_id: "s1" });
  check(
    "ignore_case matches both cases, newest seq first",
    insensitive.results.map((x) => x.seq).join(",") === "4,2",
    JSON.stringify(insensitive.results),
  );
}

{
  const r = search({ pattern: "ECONNREFUSED", context: 2, session_id: "s1" });
  const hit = r.results[0];
  check("context returns rows before by seq", hit.before?.map((x) => x.seq).join(",") === "0,1", JSON.stringify(hit.before));
  check("context returns rows after by seq", hit.after?.map((x) => x.seq).join(",") === "3,4", JSON.stringify(hit.after));
  check("context rows carry role and text", hit.before[0].role === "assistant" && hit.before[0].text === "step zero");
  const edge = search({ pattern: "step five", context: 5, session_id: "s1" });
  check("context clips at log ends", edge.results[0].before.length === 5 && edge.results[0].after.length === 0, JSON.stringify(edge.results[0]));
  const words = search({ query: "step zero", context: 1, session_id: "s1" });
  check(
    "context also works with query",
    words.results[0].seq === 0 && words.results[0].before.length === 0 && words.results[0].after[0].seq === 1,
  );
}

{
  check("context above 5 rejected", throws(() => search({ query: "step", context: 6 }), /context/));
  check("negative context rejected", throws(() => search({ query: "step", context: -1 }), /context/));
  check("fractional context rejected", throws(() => search({ query: "step", context: 1.5 }), /context/));
}

{
  check("neither query nor pattern rejected", throws(() => search({}), /exactly one of query or pattern/));
  check("blank query and no pattern rejected", throws(() => search({ query: "  " }), /exactly one of query or pattern/));
  check("both query and pattern rejected", throws(() => search({ query: "step", pattern: "step" }), /exactly one of query or pattern/));
  check("invalid regex rejected", throws(() => search({ pattern: "(unclosed" }), /invalid pattern/));
  check("pattern over 200 chars rejected", throws(() => search({ pattern: "a".repeat(201) }), /at most 200/));
  check("pattern of 200 chars accepted", search({ pattern: "a".repeat(200), session_id: "s1" }).results.length === 0);
}

{
  const r = search({ query: "step" });
  check(
    "log_files maps each searched session to its log path",
    r.log_files?.s1 === path.join(sessions, "s1.log.jsonl"),
    JSON.stringify(r.log_files),
  );
  const none = search({ query: "step", session_id: "absent" });
  check("log_files omits sessions without a log", Object.keys(none.log_files).length === 0);
}

{
  // (a+)+$ backtracks exponentially on "aaaa…b"; the scan must stop at the time budget.
  log("evil", Array.from({ length: 3 }, (_, i) => row(i, "a".repeat(5000) + "b")));
  const started = Date.now();
  const r = search({ pattern: "(a+)+$", session_id: "evil" });
  const ms = Date.now() - started;
  check("pathological regex stops within the budget", ms < 3000, `${ms} ms`);
  check("pathological regex reports timed_out and truncated", r.timed_out === true && r.truncated === true, JSON.stringify(r).slice(0, 200));
}

{
  // Only the first 20000 characters of a row are scanned.
  log("long", [row(0, "x".repeat(25_000) + "tailneedle"), row(1, "headneedle" + "x".repeat(25_000))]);
  const r = search({ pattern: "needle", session_id: "long" });
  check(
    "per-row scan cap skips matches past 20000 chars",
    r.results.map((x) => x.seq).join(",") === "1",
    JSON.stringify(r.results.map((x) => x.seq)),
  );
}

{
  log("many", Array.from({ length: 40 }, (_, i) => row(i, "needle " + "z".repeat(3000))));
  const r = search({ pattern: "needle", context: 5, session_id: "many", limit: 40 });
  const size = JSON.stringify(r, null, 2).length;
  check("output cap holds with context rows", size < 8500 && r.truncated === true, String(size));
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall context store pattern tests passed");
