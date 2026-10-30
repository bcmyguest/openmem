#!/usr/bin/env node
// smart_compact_search line_matches: matching lines across every searched row, for pattern and query.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openmem-ctx-lines-"));
const state = path.join(tmp, "state");
const sessions = path.join(state, "context", "sessions");
fs.mkdirSync(sessions, { recursive: true });
const repo = path.join(tmp, "repo");
fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
const ENV = { OPENMEM_STATE_DIR: state, HOME: tmp };
const row = (text) => ({ role: "tool", kind: "tool_result", name: "bash", text });
const log = (sid, rows) => writeSessionRows(sessions, sid, rows);
const search = (args) => callContextStoreTool("smart_compact_search", args, { env: ENV, cwd: repo });

try {
  // 30 rows of 4 lines each; two lines per row name a key, one of them twice.
  log("many", Array.from({ length: 30 }, (_, i) => row(`KEY-${i} set\nKEY-${i} KEY-${i} again\nother line\nkey lowercase`)));

  {
    const tool = CONTEXT_STORE_MCP_TOOLS.find((t) => t.name === "smart_compact_search");
    check("description explains line_matches", tool.description.includes("line_matches is an exact count of matching lines")
      && tool.description.includes("use it for 'how many' questions"));
  }

  {
    const r = await search({ pattern: "KEY-\\d+", session_id: "many", limit: 3 });
    check("pattern: line_matches counts every matching line, past the limit", r.line_matches === 60 && r.total_matches === 30 && r.results.length === 3,
      JSON.stringify({ line_matches: r.line_matches, total: r.total_matches, n: r.results.length }));
    const i = await search({ pattern: "^key", ignore_case: true, session_id: "many", limit: 1 });
    check("pattern: anchors apply per line, ignore_case honoured", i.line_matches === 90, String(i.line_matches));
    const none = await search({ pattern: "absent", session_id: "many" });
    check("pattern: zero when nothing matches", none.line_matches === 0 && none.total_matches === 0);
  }

  {
    // Row-level `^` matches only the text start; per-line `^` also finds later lines (grep -c semantics).
    log("anchor", [row("intro\nERROR one\nERROR two")]);
    const r = await search({ pattern: "^ERROR", session_id: "anchor" });
    check("pattern: a row without a row-level hit still counts its matching lines", r.total_matches === 0 && r.line_matches === 2, JSON.stringify(r));
  }

  {
    const r = await search({ query: "key-7 again", session_id: "many", limit: 1 });
    check("query: lines containing every term, case-insensitive", r.line_matches === 1, String(r.line_matches));
    const all = await search({ query: "KEY", session_id: "many", limit: 2 });
    check("query: counts across all rows, not only returned ones", all.line_matches === 90 && all.results.length === 2, String(all.line_matches));
    const partial = await search({ query: "lowercase again", session_id: "many" });
    check("query: rows matching only some terms add no lines", partial.total_matches === 30 && partial.line_matches === 0, JSON.stringify({ t: partial.total_matches, l: partial.line_matches }));
  }

  {
    // (a+)+$ backtracks exponentially on "aaaa…b"; the count stops at the budget and stays partial.
    log("evil", [row("aaa"), ...Array.from({ length: 3 }, () => row("a".repeat(5000) + "b"))]);
    const started = Date.now();
    const r = await search({ pattern: "(a+)+$", session_id: "evil" });
    check("pattern timeout returns the partial line count and timed_out", r.timed_out === true && r.line_matches === 1 && Date.now() - started < 3000,
      JSON.stringify({ timed_out: r.timed_out, line_matches: r.line_matches }));
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log("all context store line_matches tests passed");
