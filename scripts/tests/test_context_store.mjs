#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { callUnifiedTool, UNIFIED_MCP_TOOLS } from "../../cli/mcp/memory-facade.mjs";
import { callContextStoreTool, sanitizeSessionId } from "../../cli/mcp/context-store.mjs";
import { openSession } from "../../cli/coding-agent/session-db.mjs";
import { writeSessionRows } from "./fixtures/session-db.mjs";

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok    ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openmem-ctx-"));
const state = path.join(tmp, "state");
const sessions = path.join(state, "context", "sessions");
const blobs = path.join(state, "context", "blobs");
fs.mkdirSync(sessions, { recursive: true });
fs.mkdirSync(blobs, { recursive: true });
const repo = path.join(tmp, "repo");
fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
fs.mkdirSync(path.join(repo, "sub"), { recursive: true });
const other = path.join(tmp, "other");
fs.mkdirSync(other, { recursive: true });

const ENV = { ...process.env, OPENMEM_STATE_DIR: state };
const BLOB = "0123456789abcdef";

function register(sid, cwd, at) {
  fs.writeFileSync(
    path.join(sessions, `${sid}.json`),
    JSON.stringify({ session_id: sid, agent: "claude-code", cwd, bank: "coding-agent::repo", registered_at: at }),
  );
}
const log = (sid, rows) => writeSessionRows(sessions, sid, rows);
// Stored in order: seq is the position plus one. User rows, which the default role filter searches.
const row = (text, extra = {}) => ({ role: "user", kind: "text", name: null, text, ...extra });

register("old", repo, "2026-10-28T10:00:00Z");
register("new", path.join(repo, "sub"), "2026-10-29T10:00:00Z");
register("elsewhere", other, "2026-10-29T11:00:00Z");
log("old", [row("proxy port is 8787 in compose"), row("port only")]);
log("new", [
  row("the proxy listens on a port"),
  row("just proxy"),
  row("full proxy log text", { role: "tool", kind: "tool_result", name: "Bash", blob_id: BLOB }),
  row("assistant says proxy port", { role: "assistant" }),
]);
log("elsewhere", [row("proxy port elsewhere")]);
fs.writeFileSync(path.join(blobs, `${BLOB}.txt`), "x".repeat(250_000));

const search = (args, cwd = repo) => callContextStoreTool("smart_compact_search", args, { env: ENV, cwd });
const get = (args) => callContextStoreTool("smart_compact_get", args, { env: ENV });

const names = UNIFIED_MCP_TOOLS.map((t) => t.name);
for (const n of ["smart_compact_search", "smart_compact_get", "smart_compact_sql", "context_status"]) {
  const tool = UNIFIED_MCP_TOOLS.find((t) => t.name === n);
  check(`tools/list includes ${n}`, names.includes(n));
  check(`${n} is read-only`, tool?.annotations?.readOnlyHint === true && tool?.annotations?.destructiveHint === false);
}

{
  const db = openSession(path.join(sessions, "ses_status.db"));
  db.addEvent("trim", new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), "proxy:aaaaaaaaaaaa",
    { tokens_before: 1000, tokens_after: 300, dropped: 9 });
  const s = await callContextStoreTool("context_status", {}, { env: ENV });
  check("context_status summarizes events", s.trims === 1 && s.tokensSaved === 700 && s.failOpens === 0
    && /^proxy:[0-9a-f]{12}$/.test(s.checkout_proxy_version) && s.proxy_stale === true, JSON.stringify(s));
  let bad = null;
  try { await callContextStoreTool("context_status", { hours: 0 }, { env: ENV }); } catch (error) { bad = error; }
  check("context_status rejects an out-of-range window", /hours must be/.test(String(bad)));
  const sql = await callContextStoreTool("smart_compact_sql", { session_id: "ses_status", sql: "SELECT kind, dropped FROM events" }, { env: ENV });
  check("smart_compact_sql reads events", JSON.stringify(sql.rows) === JSON.stringify([{ kind: "trim", dropped: 9 }]), JSON.stringify(sql));
}

{
  const db = openSession(path.join(sessions, "ses_usage.db"));
  db.addEvent("usage", new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), "proxy:aaaaaaaaaaaa",
    { model: "claude", trimmed: 2, input_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 990, output_tokens: 5,
      breakpoints: 2, breakpoint_at: "system,m-1" });
  const s = await callContextStoreTool("context_status", {}, { env: ENV });
  check("context_status summarizes prompt-cache usage", s.usage.requests === 1 && s.usage.hitRatio === 0
    && s.usage.newCut.cacheCreationTokens === 990 && s.usage.breakpoints[2] === 1, JSON.stringify(s.usage));
}

{
  const r = await search({ query: "Proxy PORT", session_id: "new" });
  check("session filter searches only that session", r.results.every((x) => x.session_id === "new"), JSON.stringify(r));
  check("all-terms row ranks first", r.results[0]?.seq === 1 && r.results[0]?.matched_terms === 2, JSON.stringify(r.results[0]));
  // Partial matches rank by BM25: the shorter row first.
  check("partial matches rank by BM25", r.results[1]?.seq === 2 && r.results[2]?.seq === 3, JSON.stringify(r.results.map((x) => x.seq)));
  check("assistant rows excluded by default", r.total_matches === 3 && r.roles.join(",") === "user,tool", JSON.stringify(r));
  check("blob ids surfaced", r.results[2]?.blob_ids?.[0] === BLOB && !r.results[0].blob_ids, JSON.stringify(r.results[2]));
  check("row fields present", r.results[2]?.role === "tool" && r.results[2]?.kind === "tool_result" && r.results[2]?.name === "Bash");
  const all = await search({ query: "Proxy PORT", session_id: "new", role: "all" });
  check("role all includes assistant rows", all.total_matches === 4 && all.results.some((x) => x.role === "assistant"), JSON.stringify(all.results));
}

{
  const r = await search({ query: "proxy port" });
  check("cwd discovery skips sessions outside the git root", !r.sessions_searched.includes("elsewhere"), JSON.stringify(r.sessions_searched));
  check("cwd discovery orders newest registration first", r.sessions_searched.join(",") === "new,old", JSON.stringify(r.sessions_searched));
  check(
    "full matches across sessions rank above partial, newer session first",
    r.results[0]?.session_id === "new" && r.results[0]?.seq === 1 && r.results[1]?.session_id === "old" && r.results[1]?.seq === 1,
    JSON.stringify(r.results.slice(0, 2)),
  );
  check("limit applies", (await search({ query: "proxy port", limit: 2 })).results.length === 2);
}

{
  const r = await search({ query: "proxy" }, other);
  check("non-git cwd matches registration equal to cwd", r.sessions_searched.join(",") === "elsewhere", JSON.stringify(r.sessions_searched));
}

{
  const big = "a".repeat(5000) + " needle " + "b".repeat(5000);
  log("big", Array.from({ length: 40 }, () => row(big)));
  const r = await search({ query: "needle", session_id: "big", limit: 40 });
  const size = JSON.stringify(r, null, 2).length;
  check("excerpt centres on match", r.results[0]?.text.includes("needle") && r.results[0].text.length < 500, r.results[0]?.text.length);
  check("result stays under ~8000 chars and reports truncation", size < 8500 && r.truncated === true, String(size));
}

{
  let threw = 0;
  for (const bad of ["../old", "a/../../etc", "..", "x\\y"]) {
    try {
      await search({ query: "proxy", session_id: bad });
    } catch {
      threw++;
    }
  }
  check("path traversal session ids rejected", threw === 4, String(threw));
  check("unsafe chars sanitized", sanitizeSessionId("a b:c") === "a_b_c");
  check("unknown session returns empty", (await search({ query: "proxy", session_id: "nope" })).results.length === 0);
}

{
  const r = await callContextStoreTool("smart_compact_search", { query: "proxy" }, { env: { ...ENV, OPENMEM_STATE_DIR: path.join(tmp, "missing") }, cwd: repo });
  check("missing directory returns empty", r.results.length === 0 && r.sessions_searched.length === 0);
}

{
  const a = await get({ id: BLOB });
  check("blob get caps at 100k and reports truncation", a.text.length === 100_000 && a.truncated && a.next_offset === 100_000 && a.total_chars === 250_000);
  const b = await get({ id: BLOB, offset: 200_000 });
  check("blob offset pages to the end", b.text.length === 50_000 && b.truncated === false && b.next_offset === undefined);
  check("missing blob is not an error", (await get({ id: "ffffffffffffffff" })).found === false);
  let bad = 0;
  for (const id of ["0123456789ABCDEF", "0123", "../../etc/passwd", "0123456789abcdef0"]) {
    try {
      await get({ id });
    } catch {
      bad++;
    }
  }
  check("bad blob ids rejected", bad === 4, String(bad));
}

{
  const saved = process.env.OPENMEM_STATE_DIR;
  const savedCwd = process.cwd();
  process.env.OPENMEM_STATE_DIR = state;
  process.chdir(path.join(repo, "sub"));
  try {
    const ok = await callUnifiedTool({ provider: "cognee" }, "smart_compact_search", { query: "proxy port" });
    const parsed = JSON.parse(ok.content[0].text);
    check("facade reads env and cwd at call time (any provider)", !ok.isError && parsed.sessions_searched.join(",") === "new,old", ok.content[0].text.slice(0, 200));
    const err = await callUnifiedTool({ provider: "mem0" }, "smart_compact_get", { id: "nope" });
    check("facade returns bad id as tool error", err.isError === true);
  } finally {
    process.chdir(savedCwd);
    if (saved === undefined) delete process.env.OPENMEM_STATE_DIR;
    else process.env.OPENMEM_STATE_DIR = saved;
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
{
  // A session registered in a linked worktree of the same repo is found; another repo's is not.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "openmem-ctx-wt-"));
  const git = (...a) => execFileSync("git", a, { cwd: base, stdio: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  git("init", "-q", "main");
  git("-C", "main", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  git("-C", "main", "worktree", "add", "-q", "../linked");
  git("init", "-q", "other");
  const state = path.join(base, "state");
  const sessions = path.join(state, "context", "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  for (const [sid, hour] of [["wt-main", 1], ["wt-linked", 2], ["wt-other", 3]]) {
    const cwd = path.join(base, sid.slice(3));
    fs.writeFileSync(path.join(sessions, `${sid}.json`), JSON.stringify({ session_id: sid, agent: "claude-code", cwd, bank: "b", registered_at: `2026-10-29T1${hour}:00:00Z` }));
    writeSessionRows(sessions, sid, [{ role: "user", kind: "text", name: null, text: "worktree needle" }]);
  }
  const r = await callContextStoreTool("smart_compact_search", { query: "worktree needle" }, { env: { OPENMEM_STATE_DIR: state }, cwd: path.join(base, "main") });
  check(
    "cwd discovery includes linked worktrees of the same repo only",
    JSON.stringify(r.sessions_searched) === JSON.stringify(["wt-linked", "wt-main"]),
    JSON.stringify(r.sessions_searched),
  );
  fs.rmSync(base, { recursive: true, force: true });
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall context store tests passed");
