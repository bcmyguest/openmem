#!/usr/bin/env node
/**
 * Session database (sessions/<sid>.db): smart_compact_sql guards, search filters, hybrid search, JS
 * embeddings, TTL cleanup (JS and Python on the same layout), and a Python writer with a concurrent JS reader.
 * Disposable state only.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callContextStoreTool, checkReadOnlySql, CONTEXT_STORE_MCP_TOOLS, startContextStore } from "../../cli/mcp/context-store.mjs";
import {
  EMBED_MAX_FAILURES, embeddingBatchSize, maybeSweepContextStore, nearest, openSession, packVector, pendingRows, scheduleEmbedding,
  sqlite, sweepContextStore, unpackVector, vectorCounts,
} from "../../cli/coding-agent/session-db.mjs";
import { writeSessionRows } from "./fixtures/session-db.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok    ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}
async function rejects(fn, re) {
  try {
    await fn();
    return false;
  } catch (err) {
    return re.test(String(err?.message));
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openmem-sdb-"));
const state = path.join(tmp, "state");
const sessions = path.join(state, "context", "sessions");
fs.mkdirSync(sessions, { recursive: true });
const ENV = { OPENMEM_STATE_DIR: state, HOME: tmp };
const NO_CONFIG = { embeddingModel: "", embeddingUrl: "http://unused", embeddingApiKey: "" };
const search = (args, opts = {}) => callContextStoreTool("smart_compact_search", args, { env: ENV, cwd: tmp, settings: NO_CONFIG, ...opts });
const sql = (args) => callContextStoreTool("smart_compact_sql", args, { env: ENV });

try {
  const logs = [
    "level=error service=payments msg=declined", "level=info service=payments msg=ok",
    "level=error service=auth msg=expired", "level=error service=payments msg=timeout",
  ].join("\n");
  writeSessionRows(sessions, "s1", [
    { role: "user", text: "check the payment logs" },
    { role: "assistant", kind: "tool_use", name: "Bash", text: '{"command":"tail app.log"}', in_context: false },
    { role: "tool", kind: "tool_result", name: "Bash", text: logs, in_context: false },
    { role: "assistant", text: "payments has errors", in_context: false },
    { role: "assistant", kind: "tool_use", name: "Read", text: '{"path":"a"}' },
    { role: "tool", kind: "tool_result", name: "Read", text: "error in a" },
    { role: "user", text: "why do payments fail" },
  ]);

  // smart_compact_sql: the description's examples run; writes, ATTACH, PRAGMA and extra statements do not.
  {
    const tool = CONTEXT_STORE_MCP_TOOLS.find((t) => t.name === "smart_compact_sql");
    check("sql tool is read-only and documents the schema", tool.annotations.readOnlyHint === true
      && tool.description.includes("messages(seq") && tool.description.includes("lines(") && tool.description.includes("GROUP BY"));
    const examples = [...tool.description.matchAll(/\(\d\) [^:]+: (SELECT[^;]+?)(?:;| \(|\. Writes)/g)].map((m) => m[1]);
    check("description carries three example queries", examples.length === 3, JSON.stringify(examples));
    const results = [];
    for (const q of examples) results.push(await sql({ session_id: "s1", sql: q }));
    check("example 1 counts lines matching level and service", results[0].rows[0].n === 2, JSON.stringify(results[0]));
    check("example 2 groups tool calls", JSON.stringify(results[1].rows.map((r) => `${r.name}:${r.calls}`).sort()) === '["Bash:1","Read:1"]', JSON.stringify(results[1].rows));
    check("example 3 runs FTS through the authorizer", results[2].rows.length === 2 && results[2].rows[0].errors === 3, JSON.stringify(results[2].rows));

    for (const bad of ["DELETE FROM messages", "WITH x AS (SELECT 1) DELETE FROM messages", "SELECT 1; DROP TABLE lines",
      "ATTACH '/tmp/x.db' AS x", "PRAGMA user_version = 3", "SELECT * FROM messages; PRAGMA journal_mode = DELETE",
      "INSERT INTO lines VALUES (1, 1, 1, 'u', 'x')", "WITH a AS (SELECT 1) REPLACE INTO lines SELECT * FROM lines", "VACUUM", "  "]) {
      check(`rejected: ${bad.trim() || "blank"}`, await rejects(() => sql({ session_id: "s1", sql: bad }), /read-only|only SELECT|one statement|required/));
    }
    check("keywords inside strings and comments are fine", checkReadOnlySql("SELECT 'DELETE; ATTACH' AS a -- PRAGMA\n") === "SELECT 'DELETE; ATTACH' AS a -- PRAGMA");
    check("replace() is a function, not a write", (await sql({ session_id: "s1", sql: "SELECT replace(text, 'a', 'b') AS r FROM messages WHERE seq = 1" })).rows[0].r === "check the pbyment logs");
    const db = sqlite();
    const conn = new db.DatabaseSync(path.join(sessions, "s1.db"), { readOnly: true });
    check("database untouched", conn.prepare("SELECT count(*) AS n FROM messages").get().n === 7);
    conn.close();

    const capped = await sql({ session_id: "s1", sql: "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT 500) SELECT x FROM c" });
    check("row cap 200 with truncated flag", capped.rows.length === 200 && capped.truncated === true && capped.columns.join() === "x");
    const started = Date.now();
    check("runaway query stops at the time limit", await rejects(() => sql({ session_id: "s1", sql: "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c" }), /stopped after 2 s/)
      && Date.now() - started < 5000, `${Date.now() - started} ms`);
    check("syntax errors are reported", await rejects(() => sql({ session_id: "s1", sql: "SELECT FROM" }), /query failed/));
    check("missing database is an error", await rejects(() => sql({ session_id: "nope", sql: "SELECT 1" }), /no session database/));
    check("path-like session id rejected", await rejects(() => sql({ session_id: "../s1", sql: "SELECT 1" }), /invalid session_id/));
  }

  // Search filters: role default user+tool, role all, in_context, and line_matches under the same filters.
  {
    const def = await search({ query: "payments", session_id: "s1" });
    check("default roles skip assistant rows", def.results.every((r) => r.role !== "assistant") && def.total_matches === 2, JSON.stringify(def.results.map((r) => [r.seq, r.role])));
    check("line_matches covers the whole session under the filters", def.line_matches === 4, String(def.line_matches));
    const all = await search({ query: "payments", session_id: "s1", role: "all" });
    check("role all adds assistant rows and their lines", all.total_matches === 3 && all.line_matches === 5, JSON.stringify([all.total_matches, all.line_matches]));
    const trimmed = await search({ query: "error", session_id: "s1", in_context: false });
    check("in_context false keeps trimmed rows only", trimmed.results.map((r) => r.seq).join() === "3" && trimmed.line_matches === 3 && trimmed.in_context === false, JSON.stringify(trimmed));
    const live = await search({ pattern: "error", session_id: "s1", in_context: true });
    check("in_context true keeps rows still in context", live.results.map((r) => r.seq).join() === "6" && live.line_matches === 1, JSON.stringify(live.results));
    const tools = await search({ query: "error", session_id: "s1", role: ["tool"] });
    check("role list filters", tools.total_matches === 2 && tools.results.every((r) => r.role === "tool"));
    check("bad role rejected", await rejects(() => search({ query: "x", session_id: "s1", role: "system" }), /role must be/));
    check("bad in_context rejected", await rejects(() => search({ query: "x", session_id: "s1", in_context: "no" }), /in_context/));
    check("punctuation-only query rejected", await rejects(() => search({ query: "--", session_id: "s1" }), /no searchable words/));
    check("lexical without vectors", def.mode === "lexical");
  }

  // Hybrid: RRF of BM25 and cosine when the session has vectors; lexical on request or on embedding failure.
  {
    writeSessionRows(sessions, "h1", [
      { role: "user", text: "alpha alpha" }, { role: "user", text: "beta" }, { role: "user", text: "gamma alpha" },
    ]);
    const s = openSession(path.join(sessions, "h1.db"));
    const vec = { 1: [1, 0, 0], 2: [0, 1, 0], 3: [0.6, 0.8, 0] };
    for (const [seq, v] of Object.entries(vec)) s.db.prepare("INSERT INTO vectors VALUES (?, 'm', 3, ?)").run(Number(seq), packVector(v));
    const fetches = [];
    const fakeFetch = async (url, init) => {
      fetches.push({ url, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ data: [{ index: 0, embedding: [0, 1, 0] }] }) };
    };
    const opts = { settings: { embeddingModel: "", embeddingUrl: "http://emb/v1", embeddingApiKey: "" }, fetch: fakeFetch };
    const hybrid = await search({ query: "beta", session_id: "h1" }, opts);
    check("hybrid is the default with vectors", hybrid.mode === "hybrid" && fetches.length === 1
      && fetches[0].url === "http://emb/v1/embeddings" && fetches[0].body.model === "m" && fetches[0].body.input[0] === "beta", JSON.stringify(fetches));
    // beta: BM25 rank 1 and cosine rank 1; seq 3 (cosine 0.8) beats seq 1 (cosine 0).
    check("RRF merges both rankings", hybrid.results.map((r) => r.seq).join() === "2,3,1", JSON.stringify(hybrid.results.map((r) => [r.seq, r.similarity])));
    check("vector-only hits carry similarity and no matched terms", hybrid.results[1].matched_terms === 0 && hybrid.results[1].similarity === 0.8);
    check("total_matches stays lexical", hybrid.total_matches === 1);
    const lexical = await search({ query: "beta", session_id: "h1", mode: "lexical" }, opts);
    check("mode lexical skips vectors", lexical.mode === "lexical" && lexical.results.map((r) => r.seq).join() === "2" && fetches.length === 1);
    const failing = await search({ query: "beta", session_id: "h1" }, { ...opts, fetch: async () => ({ ok: false, status: 503 }) });
    check("embedding failure falls back to lexical", failing.mode === "lexical" && failing.embedding_error === "embeddings HTTP 503" && failing.results.length === 1);
    check("bad mode rejected", await rejects(() => search({ query: "beta", session_id: "h1", mode: "vector" }, opts), /mode/));
    check("nearest ranks by cosine, ties by seq", nearest(s.db, [1, 0, 0], "m", 3).map((x) => x[0]).join() === "1,3,2");
  }

  // JS embeddings off the hook path: scheduled per database, stored as float32 little-endian, read by Python.
  {
    writeSessionRows(sessions, "e1", [{ role: "user", text: "aaaa" }, { role: "assistant", text: "bbbb" }, { role: "user", text: "  " }]);
    const file = path.join(sessions, "e1.db");
    const calls = [];
    const fetchFn = async (_url, init) => {
      const { input } = JSON.parse(init.body);
      calls.push(input);
      return { ok: true, json: async () => ({ data: input.map((t, index) => ({ index, embedding: [t.split("a").length - 1, t.split("b").length - 1, 0.5] })) }) };
    };
    const stored = await scheduleEmbedding(file, { model: "fake", url: "http://x/v1" }, { fetchFn });
    check("blank rows are not embedded, newest first", stored === 2 && calls.length === 1 && calls[0].join("|") === "bbbb|aaaa", JSON.stringify(calls));
    check("second run finds nothing new", (await scheduleEmbedding(file, { model: "fake", url: "http://x/v1" }, { fetchFn })) === 0 && calls.length === 1);
    const row = openSession(file).db.prepare("SELECT dim, blob FROM vectors WHERE message_seq = 1").get();
    check("vector round-trips", JSON.stringify(unpackVector(row.blob, row.dim)) === "[4,0,0.5]");
    const py = spawnSync("python3", ["-c", [
      "import sys, json, sqlite3",
      `sys.path.insert(0, ${JSON.stringify(path.join(ROOT, "proxy"))})`,
      "from openmem_context.sessiondb import nearest",
      `c = sqlite3.connect(${JSON.stringify(file)})`,
      "print(json.dumps([[s, round(v, 6)] for s, v in nearest(c, [0.0, 1.0, 0.0], 'fake', 2)]))",
    ].join("\n")], { encoding: "utf8" });
    const jsNear = nearest(openSession(file).db, [0, 1, 0], "fake", 2).map(([seq, v]) => [seq, Math.round(v * 1e6) / 1e6]);
    check("Python reads JS vectors and ranks them the same", py.status === 0 && JSON.stringify(JSON.parse(py.stdout)) === JSON.stringify(jsNear), `${py.stdout} ${py.stderr} vs ${JSON.stringify(jsNear)}`);
    let errors = 0;
    const down = await scheduleEmbedding(path.join(sessions, "s1.db"), { model: "fake", url: "http://x/v1" }, { fetchFn: async () => { throw new Error("down"); }, onError: () => errors++ });
    check("embedding failure is reported, not thrown", down === 0 && errors === 1);
    check("failed database waits before retrying", (await scheduleEmbedding(path.join(sessions, "s1.db"), { model: "fake", url: "http://x/v1" }, { fetchFn })) === 0 && calls.length === 1);
  }

  // Adaptive batches on a slow endpoint, trimmed rows newest first, row skipping, and the search's vector status.
  {
    const rows = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `row ${i + 1} ${"x".repeat(20)}`, in_context: !(i >= 1 && i <= 5) }));
    const file = writeSessionRows(sessions, "a1", rows);
    const fakeVectors = (input) => ({ ok: true, json: async () => ({ data: input.map((t, index) => ({ index, embedding: [t.length, 1, 0] })) }) });
    const calls = [];
    // Like a CPU-only Ollama: more than two rows per call never finish inside the timeout.
    const slow = async (_url, init) => {
      const { input } = JSON.parse(init.body);
      calls.push(input);
      if (input.length > 2) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      return fakeVectors(input);
    };
    const logs = [];
    const config = { model: "m", url: "http://slow/v1", timeoutS: 30, maxChars: 6 };
    const stored = await scheduleEmbedding(file, config, { fetchFn: slow, log: (m) => logs.push(m) });
    const sizes = calls.map((c) => c.length);
    check("slow endpoint: every row gets a vector", stored === 20 && vectorCounts(openSession(file).db, "m").filled === 20, `${stored} ${sizes}`);
    check("slow endpoint: one failed probe at 4, then batches of at most 2", sizes[0] === 4 && sizes.slice(1).every((n) => n <= 2)
      && embeddingBatchSize("http://slow/v1", "m") === 2, String(sizes));
    check("trimmed rows first, newest first, head only", calls[1].join("|") === "row 6 |row 5 " && calls.flat().every((t) => t.length <= 6), JSON.stringify(calls[1]));
    check("one log line per batch", logs[0] === "embedding batch failed TimeoutError rows=4 seconds=0.0 batch=2"
      && logs[1].startsWith("embedded rows=2 seconds=") && logs.length === calls.length, JSON.stringify(logs.slice(0, 2)));

    const grow = [];
    const fast = async (_url, init) => {
      const { input } = JSON.parse(init.body);
      grow.push(input.length);
      return fakeVectors(input);
    };
    const big = writeSessionRows(sessions, "a2", Array.from({ length: 40 }, (_, i) => ({ text: `r${i}` })));
    await scheduleEmbedding(big, { model: "m", url: "http://fast/v1" }, { fetchFn: fast, log: () => {} });
    check("fast endpoint: batches grow", grow.join() === "4,8,16,12" && embeddingBatchSize("http://fast/v1", "m") === 32, grow.join());

    const poisoned = writeSessionRows(sessions, "a3", [{ text: "good 1" }, { text: "poison" }, { text: "good 2" }, { text: "good 3" }]);
    let picky = 0;
    const pickyFetch = async (_url, init) => {
      const { input } = JSON.parse(init.body);
      picky++;
      if (input.includes("poison")) throw new Error("embeddings HTTP 500");
      return fakeVectors(input);
    };
    const skipLogs = [];
    for (let i = 0; i < EMBED_MAX_FAILURES; i++) await scheduleEmbedding(poisoned, { model: "m", url: "http://picky/v1" }, { fetchFn: pickyFetch, log: (m) => skipLogs.push(m) });
    const counts = vectorCounts(openSession(poisoned).db, "m");
    check("row failing alone is skipped and recorded", JSON.stringify(counts) === '{"filled":3,"pending":0,"skipped":1}'
      && skipLogs.includes(`embedding skipped seq=2 after ${EMBED_MAX_FAILURES} failures`), `${JSON.stringify(counts)} ${skipLogs}`);
    const before = picky;
    await scheduleEmbedding(poisoned, { model: "m", url: "http://picky/v1" }, { fetchFn: pickyFetch, log: () => {} });
    check("skipped row is not retried", picky === before);
    check("skipped row never ranks", !nearest(openSession(poisoned).db, [1, 1, 0], "m", 10).some(([seq]) => seq === 2));

    // Python picks the same rows in the same order.
    const fresh = writeSessionRows(sessions, "a4", rows);
    const py = spawnSync("python3", ["-c", [
      "import sys, json, sqlite3",
      `sys.path.insert(0, ${JSON.stringify(path.join(ROOT, "proxy"))})`,
      "from openmem_context.embed import pending_rows",
      `c = sqlite3.connect(${JSON.stringify(fresh)})`,
      "print(json.dumps([s for s, _ in pending_rows(c, 'm', 8, {3, 9})], separators=(',', ':')))",
    ].join("\n")], { encoding: "utf8" });
    const jsOrder = pendingRows(openSession(fresh).db, "m", 8, [3, 9]).map((r) => r.seq);
    check("Python and JS embed rows in the same order", py.status === 0 && py.stdout.trim() === JSON.stringify(jsOrder)
      && jsOrder.join() === "6,5,4,2,20,19,18,17", `${py.stdout} ${py.stderr} vs ${jsOrder}`);

    const half = writeSessionRows(sessions, "a5", [{ text: "alpha one" }, { text: "alpha two" }, { text: "beta" }]);
    openSession(half).db.prepare("INSERT INTO vectors VALUES (1, 'm', 3, ?)").run(packVector([1, 0, 0]));
    const status = await search({ query: "alpha", session_id: "a5", mode: "lexical" }, { settings: { ...NO_CONFIG, embeddingModel: "m" } });
    check("search reports vector progress", JSON.stringify(status.vectors) === '{"filled":1,"pending":2,"skipped":0}', JSON.stringify(status.vectors));
    const none = await search({ query: "alpha", session_id: "s1" });
    check("no vector status without a model", none.vectors === undefined);
  }

  // TTL: JS and Python delete the same sessions from the same layout; the stamp limits runs to one a day.
  {
    const layout = { "old.db": 40, "old.db-wal": 40, "old.db-shm": 40, "old.json": 40, "old.trim.json": 40, "old.log.jsonl": 40,
      "mixed.db": 40, "mixed.json": 1, "new.db": 2, ".x.tmp": 90, "notes.txt": 90 };
    const make = (dir) => {
      fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
      for (const [name, age] of Object.entries(layout)) {
        const f = path.join(dir, "sessions", name);
        fs.writeFileSync(f, "x");
        const t = (Date.now() - age * 86_400_000) / 1000;
        fs.utimesSync(f, t, t);
      }
    };
    const jsRoot = path.join(tmp, "ttl-js");
    const pyRoot = path.join(tmp, "ttl-py");
    make(jsRoot);
    make(pyRoot);
    const jsDeleted = sweepContextStore(jsRoot, 30);
    const py = spawnSync("python3", ["-c", `import sys, json; sys.path.insert(0, ${JSON.stringify(path.join(ROOT, "proxy"))}); `
      + `from openmem_context.ttl import sweep; print(json.dumps(sweep(${JSON.stringify(pyRoot)}, 30)))`], { encoding: "utf8" });
    const left = (dir) => fs.readdirSync(path.join(dir, "sessions")).sort().join(",");
    check("JS sweep deletes whole stale sessions only", jsDeleted.join() === "old" && left(jsRoot) === ".x.tmp,mixed.db,mixed.json,new.db,notes.txt", left(jsRoot));
    check("Python sweep matches JS", py.status === 0 && py.stdout.trim() === JSON.stringify(jsDeleted) && left(pyRoot) === left(jsRoot), py.stdout + py.stderr);
    check("ttl 0 keeps everything", sweepContextStore(jsRoot, 0, Date.now() + 10 ** 12).length === 0);
    const stampRoot = path.join(tmp, "ttl-stamp");
    make(stampRoot);
    check("first run sweeps", maybeSweepContextStore(stampRoot, 30).join() === "old");
    make(stampRoot);
    check("second run within a day does nothing", maybeSweepContextStore(stampRoot, 30).length === 0);
    check("a day later it sweeps again", maybeSweepContextStore(stampRoot, 30, Date.now() + 86_400_001).join() === "old");
    const mcpRoot = path.join(tmp, "ttl-mcp", "context");
    make(mcpRoot);
    const deleted = await startContextStore({ OPENMEM_STATE_DIR: path.dirname(mcpRoot), HOME: tmp, CONTEXT_STORE_TTL_DAYS: "30" }, { stackRoot: tmp });
    check("MCP start runs the sweep", deleted.join() === "old" && fs.existsSync(path.join(mcpRoot, ".ttl-stamp")));
    const kept = await startContextStore({ OPENMEM_STATE_DIR: path.join(tmp, "ttl-off"), HOME: tmp, CONTEXT_STORE_TTL_DAYS: "0" }, { stackRoot: tmp });
    check("ttl_days 0 skips the sweep", kept.length === 0 && !fs.existsSync(path.join(tmp, "ttl-off", "context", ".ttl-stamp")));
  }

  // A Python writer (the proxy) and a JS reader (the MCP server) on one database at the same time.
  {
    const writer = [
      "import sys, copy",
      `sys.path.insert(0, ${JSON.stringify(path.join(ROOT, "proxy"))})`,
      "from pathlib import Path",
      "from openmem_context import Settings, process_request",
      `ctx = Path(${JSON.stringify(path.join(tmp, "conc", "context"))})`,
      "msgs = [{'role': 'user', 'content': 'task'}]",
      "for i in range(150):",
      "    msgs += [{'role': 'assistant', 'content': f'reply {i} needle'}, {'role': 'user', 'content': f'turn {i} needle'}]",
      "    data = {'messages': copy.deepcopy(msgs), 'proxy_server_request': {'headers': {'x-openmem-session-id': 'conc'}}}",
      "    process_request(data, 'acompletion', Settings(trim_at_tokens=400, compress_over_tokens=0, context_dir=ctx))",
      "print('done')",
    ].join("\n");
    const child = spawn("python3", ["-c", writer], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    const done = new Promise((resolve) => child.on("exit", resolve));
    const cenv = { OPENMEM_STATE_DIR: path.join(tmp, "conc"), HOME: tmp };
    let reads = 0;
    let readErrors = 0;
    let exited = false;
    done.then(() => { exited = true; });
    let lastLines = 0;
    let monotonic = true;
    while (!exited) {
      try {
        const r = await callContextStoreTool("smart_compact_search", { query: "needle", session_id: "conc", role: "all" }, { env: cenv, settings: NO_CONFIG });
        if (r.line_matches < lastLines) monotonic = false;
        lastLines = r.line_matches;
        reads++;
      } catch (err) {
        if (!/no such table|unable to open/.test(String(err?.message))) readErrors++;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const code = await done;
    const final = await callContextStoreTool("smart_compact_search", { query: "needle", session_id: "conc", role: "all", limit: 1 }, { env: cenv, settings: NO_CONFIG });
    check("writer finished without errors", code === 0 && !stderr.includes("fail-open"), stderr);
    check("reader never failed while the writer ran", readErrors === 0 && reads > 3, `${reads} reads, ${readErrors} errors`);
    check("reader saw counts only grow", monotonic);
    check("every message stored once", final.line_matches === 300, String(final.line_matches));
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall session database tests passed");
