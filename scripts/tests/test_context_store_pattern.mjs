#!/usr/bin/env node
// smart_compact_search pattern/context params, exactly-one-of validation, regex guard, databases.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { callContextStoreTool, CONTEXT_STORE_MCP_TOOLS } from "../../cli/mcp/context-store.mjs";
import { writeSessionRows } from "./fixtures/session-db.mjs";

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok    ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}
async function throws(fn, re) {
  try {
    await fn();
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

// Rows are stored in order, so seq is the position plus one.
const row = (text, extra = {}) => ({ role: "user", kind: "text", name: null, text, ...extra });
const log = (sid, rows) => writeSessionRows(sessions, sid, rows);
fs.writeFileSync(
  path.join(sessions, "s1.json"),
  JSON.stringify({ session_id: "s1", agent: "claude-code", cwd: repo, bank: "b", registered_at: "2026-10-29T10:00:00Z" }),
);
log("s1", [
  row("step zero"),
  row("step one"),
  row("Error: ECONNREFUSED 127.0.0.1:4100"),
  row("step three"),
  row("error: timeout after 30s"),
  row("step five"),
]);

const search = (args) => callContextStoreTool("smart_compact_search", args, { env: ENV, cwd: repo });

{
  const tool = CONTEXT_STORE_MCP_TOOLS.find((t) => t.name === "smart_compact_search");
  const props = tool.inputSchema.properties;
  check("schema exposes pattern, ignore_case, context", Boolean(props.pattern && props.ignore_case && props.context));
  check("schema no longer requires query", !(tool.inputSchema.required || []).includes("query"));
}

{
  const r = await search({ pattern: "ECONNREFUSED \\d+\\.\\d+\\.\\d+\\.\\d+:\\d+", session_id: "s1" });
  check("regex finds the matching row", r.results.length === 1 && r.results[0].seq === 3, JSON.stringify(r.results));
  check(
    "pattern echoed, no query or matched_terms",
    r.pattern?.startsWith("ECONNREFUSED") && r.query === undefined && r.results[0].matched_terms === undefined,
  );
  check("no context key without context", r.results[0].before === undefined && r.results[0].after === undefined);
}

{
  const sensitive = await search({ pattern: "^error:", session_id: "s1" });
  check("pattern is case-sensitive by default", sensitive.results.map((x) => x.seq).join(",") === "5", JSON.stringify(sensitive.results));
  const insensitive = await search({ pattern: "^error:", ignore_case: true, session_id: "s1" });
  check(
    "ignore_case matches both cases, newest seq first",
    insensitive.results.map((x) => x.seq).join(",") === "5,3",
    JSON.stringify(insensitive.results),
  );
}

{
  const r = await search({ pattern: "ECONNREFUSED", context: 2, session_id: "s1" });
  const hit = r.results[0];
  check("context returns rows before by seq", hit.before?.map((x) => x.seq).join(",") === "1,2", JSON.stringify(hit.before));
  check("context returns rows after by seq", hit.after?.map((x) => x.seq).join(",") === "4,5", JSON.stringify(hit.after));
  check("context rows carry role and text", hit.before[0].role === "user" && hit.before[0].text === "step zero");
  const edge = await search({ pattern: "step five", context: 5, session_id: "s1" });
  check("context clips at session ends", edge.results[0].before.length === 5 && edge.results[0].after.length === 0, JSON.stringify(edge.results[0]));
  const words = await search({ query: "step zero", context: 1, session_id: "s1" });
  check(
    "context also works with query",
    words.results[0].seq === 1 && words.results[0].before.length === 0 && words.results[0].after[0].seq === 2,
  );
}

{
  check("context above 5 rejected", await throws(() => search({ query: "step", context: 6 }), /context/));
  check("negative context rejected", await throws(() => search({ query: "step", context: -1 }), /context/));
  check("fractional context rejected", await throws(() => search({ query: "step", context: 1.5 }), /context/));
}

{
  check("neither query nor pattern rejected", await throws(() => search({}), /exactly one of query or pattern/));
  check("blank query and no pattern rejected", await throws(() => search({ query: "  " }), /exactly one of query or pattern/));
  check("both query and pattern rejected", await throws(() => search({ query: "step", pattern: "step" }), /exactly one of query or pattern/));
  check("invalid regex rejected", await throws(() => search({ pattern: "(unclosed" }), /invalid pattern/));
  check("pattern over 200 chars rejected", await throws(() => search({ pattern: "a".repeat(201) }), /at most 200/));
  check("pattern of 200 chars accepted", (await search({ pattern: "a".repeat(200), session_id: "s1" })).results.length === 0);
}

{
  const r = await search({ query: "step" });
  check(
    "databases maps each searched session to its database path",
    r.databases?.s1 === path.join(sessions, "s1.db"),
    JSON.stringify(r.databases),
  );
  const none = await search({ query: "step", session_id: "absent" });
  check("databases omits sessions without a database", Object.keys(none.databases).length === 0);
}

{
  // (a+)+$ backtracks exponentially on "aaaa…b"; the scan must stop at the time budget.
  log("evil", Array.from({ length: 3 }, () => row("a".repeat(5000) + "b")));
  const started = Date.now();
  const r = await search({ pattern: "(a+)+$", session_id: "evil" });
  const ms = Date.now() - started;
  check("pathological regex stops within the budget", ms < 3000, `${ms} ms`);
  check("pathological regex reports timed_out and truncated", r.timed_out === true && r.truncated === true, JSON.stringify(r).slice(0, 200));
}

{
  // Only the first 20000 characters of a row are scanned.
  log("long", [row("x".repeat(25_000) + "tailneedle"), row("headneedle" + "x".repeat(25_000))]);
  const r = await search({ pattern: "needle", session_id: "long" });
  check(
    "per-row scan cap skips matches past 20000 chars",
    r.results.map((x) => x.seq).join(",") === "2",
    JSON.stringify(r.results.map((x) => x.seq)),
  );
}

{
  log("many", Array.from({ length: 40 }, () => row("needle " + "z".repeat(3000))));
  const r = await search({ pattern: "needle", context: 5, session_id: "many", limit: 40 });
  const size = JSON.stringify(r, null, 2).length;
  check("output cap holds with context rows", size < 8500 && r.truncated === true, String(size));
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall context store pattern tests passed");
