#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { callUnifiedTool, UNIFIED_MCP_TOOLS } from "../../cli/mcp/memory-facade.mjs";
import { callContextStoreTool, sanitizeSessionId } from "../../cli/mcp/context-store.mjs";

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
function log(sid, rows) {
  fs.writeFileSync(path.join(sessions, `${sid}.log.jsonl`), rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n");
}
const row = (seq, text, extra = {}) => ({ seq, ts: "2026-10-29T17:00:00Z", role: "assistant", kind: "text", name: null, text, ...extra });

register("old", repo, "2026-10-28T10:00:00Z");
register("new", path.join(repo, "sub"), "2026-10-29T10:00:00Z");
register("elsewhere", other, "2026-10-29T11:00:00Z");
log("old", [row(0, "proxy port is 8787 in compose"), row(1, "port only")]);
log("new", [
  row(0, "the proxy listens on a port"),
  "{not json",
  "",
  row(1, "just proxy"),
  row(2, `[openmem: tool result compressed, 900 tokens — smart_compact_get(id="${BLOB}") returns the full text] [blob:${BLOB}] proxy log`, {
    role: "tool",
    kind: "tool_result",
    name: "Bash",
  }),
  JSON.stringify({ seq: 3, text: 42 }),
]);
log("elsewhere", [row(0, "proxy port elsewhere")]);
fs.writeFileSync(path.join(blobs, `${BLOB}.txt`), "x".repeat(250_000));

const search = (args, cwd = repo) => callContextStoreTool("smart_compact_search", args, { env: ENV, cwd });
const get = (args) => callContextStoreTool("smart_compact_get", args, { env: ENV });

const names = UNIFIED_MCP_TOOLS.map((t) => t.name);
for (const n of ["smart_compact_search", "smart_compact_get"]) {
  const tool = UNIFIED_MCP_TOOLS.find((t) => t.name === n);
  check(`tools/list includes ${n}`, names.includes(n));
  check(`${n} is read-only`, tool?.annotations?.readOnlyHint === true && tool?.annotations?.destructiveHint === false);
}

{
  const r = search({ query: "Proxy PORT", session_id: "new" });
  check("session filter searches only that session", r.results.every((x) => x.session_id === "new"), JSON.stringify(r));
  check("all-terms row ranks first", r.results[0]?.seq === 0 && r.results[0]?.matched_terms === 2, JSON.stringify(r.results[0]));
  check("partial ties break by seq desc", r.results[1]?.seq === 2 && r.results[2]?.seq === 1, JSON.stringify(r.results.map((x) => x.seq)));
  check("malformed and non-string rows skipped", r.total_matches === 3, String(r.total_matches));
  check("blob ids surfaced", r.results[1]?.blob_ids?.[0] === BLOB && !r.results[0].blob_ids, JSON.stringify(r.results[1]));
  check("row fields present", r.results[1]?.role === "tool" && r.results[1]?.kind === "tool_result" && r.results[1]?.name === "Bash");
}

{
  const r = search({ query: "proxy port" });
  check("cwd discovery skips sessions outside the git root", !r.sessions_searched.includes("elsewhere"), JSON.stringify(r.sessions_searched));
  check("cwd discovery orders newest registration first", r.sessions_searched.join(",") === "new,old", JSON.stringify(r.sessions_searched));
  check(
    "full matches across sessions rank above partial, newer session first",
    r.results[0]?.session_id === "new" && r.results[0]?.seq === 0 && r.results[1]?.session_id === "old" && r.results[1]?.seq === 0,
    JSON.stringify(r.results.slice(0, 2)),
  );
  check("limit applies", search({ query: "proxy port", limit: 2 }).results.length === 2);
}

{
  const r = search({ query: "proxy" }, other);
  check("non-git cwd matches registration equal to cwd", r.sessions_searched.join(",") === "elsewhere", JSON.stringify(r.sessions_searched));
}

{
  const big = "a".repeat(5000) + " needle " + "b".repeat(5000);
  log("big", Array.from({ length: 40 }, (_, i) => row(i, big)));
  const r = search({ query: "needle", session_id: "big", limit: 40 });
  const size = JSON.stringify(r, null, 2).length;
  check("excerpt centres on match", r.results[0]?.text.includes("needle") && r.results[0].text.length < 500, r.results[0]?.text.length);
  check("result stays under ~8000 chars and reports truncation", size < 8500 && r.truncated === true, String(size));
}

{
  let threw = 0;
  for (const bad of ["../old", "a/../../etc", "..", "x\\y"]) {
    try {
      search({ query: "proxy", session_id: bad });
    } catch {
      threw++;
    }
  }
  check("path traversal session ids rejected", threw === 4, String(threw));
  check("unsafe chars sanitized", sanitizeSessionId("a b:c") === "a_b_c");
  check("unknown session returns empty", search({ query: "proxy", session_id: "nope" }).results.length === 0);
}

{
  const r = callContextStoreTool("smart_compact_search", { query: "proxy" }, { env: { ...ENV, OPENMEM_STATE_DIR: path.join(tmp, "missing") }, cwd: repo });
  check("missing directory returns empty", r.results.length === 0 && r.sessions_searched.length === 0);
}

{
  const a = get({ id: BLOB });
  check("blob get caps at 100k and reports truncation", a.text.length === 100_000 && a.truncated && a.next_offset === 100_000 && a.total_chars === 250_000);
  const b = get({ id: BLOB, offset: 200_000 });
  check("blob offset pages to the end", b.text.length === 50_000 && b.truncated === false && b.next_offset === undefined);
  check("missing blob is not an error", get({ id: "ffffffffffffffff" }).found === false);
  let bad = 0;
  for (const id of ["0123456789ABCDEF", "0123", "../../etc/passwd", "0123456789abcdef0"]) {
    try {
      get({ id });
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
    fs.writeFileSync(path.join(sessions, `${sid}.log.jsonl`), JSON.stringify({ seq: 0, ts: "t", role: "user", kind: "text", name: null, text: "worktree needle" }) + "\n");
  }
  const r = callContextStoreTool("smart_compact_search", { query: "worktree needle" }, { env: { OPENMEM_STATE_DIR: state }, cwd: path.join(base, "main") });
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
