/**
 * Provider-independent smart_compact_* tools: read the context proxy's handoff logs and blobs.
 * File layout and row shape follow docs/context-store.md. Local reads only; never writes.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { contextRoot as hookContextRoot, sanitizeSessionId as hookSanitizeSessionId } from "../coding-agent/context-store.mjs";

const DEFAULT_LIMIT = 8;
const MAX_SESSIONS = 20;
const RESULT_MAX_CHARS = 8000;
const EXCERPT_CHARS = 400;
const BLOB_MAX_CHARS = 100_000;
const BLOB_ID_RE = /^[0-9a-f]{16}$/;
const BLOB_REF_RE = /\[blob:([0-9a-f]{16})\]/g;
const LOG_SUFFIX = ".log.jsonl";
const PATTERN_MAX_CHARS = 200;
const PATTERN_ROW_CHARS = 20_000;
const PATTERN_BUDGET_MS = 1000;
const CONTEXT_MAX = 5;

export const CONTEXT_STORE_MCP_TOOLS = [
  {
    name: "smart_compact_search",
    title: "Search trimmed session context",
    description:
      "Search the handoff log of conversation turns the OpenMem context proxy trimmed from this or earlier sessions " +
      "(user and assistant text, tool calls, tool results) and return matching rows with an excerpt. " +
      "Use when an [openmem: continuing session …] pointer says earlier messages were trimmed and you need a detail from them; " +
      "pass that session_id. Without session_id it searches recent sessions registered under this workspace's git root. " +
      "Pass exactly one of query (words) or pattern (JavaScript regex, rg-style); context adds that many neighbouring rows " +
      "before and after each hit. log_files maps each searched session to its JSONL log, which a shell-capable agent can rg directly. " +
      "Rows citing [blob:<id>] return blob_ids for smart_compact_get. Not durable project memory: use memory_recall for that. " +
      "Local files only; works with every provider. Read-only.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to find (case-insensitive; rows containing every word rank first). Omit when passing pattern" },
        pattern: {
          type: "string",
          description: `JavaScript regex source, at most ${PATTERN_MAX_CHARS} characters; scans the first ${PATTERN_ROW_CHARS} characters of each row. Omit when passing query`,
        },
        ignore_case: { type: "boolean", description: "Match pattern case-insensitively (default false)" },
        context: { type: "number", description: `Neighbouring rows (by seq) to return before and after each hit, 0-${CONTEXT_MAX} (default 0)` },
        session_id: { type: "string", description: "Session id from the [openmem: continuing session …] pointer" },
        limit: { type: "number", description: `Max rows (default ${DEFAULT_LIMIT})` },
      },
      additionalProperties: false,
    },
  },
  {
    name: "smart_compact_get",
    title: "Read a compressed tool result",
    description:
      "Return the full text of a tool result the context proxy compressed, by the 16-hex id from " +
      '[openmem: tool result compressed … smart_compact_get(id="<id>")] or a smart_compact_search blob_ids entry. ' +
      `Output is capped at ${BLOB_MAX_CHARS} characters; pass offset (next_offset) to page through longer results. ` +
      "Not for searching: use smart_compact_search. Local files only; works with every provider. Read-only.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Blob id: exactly 16 lowercase hex characters" },
        offset: { type: "number", description: "Character offset to start from (default 0)" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
];

export const CONTEXT_STORE_TOOL_NAMES = new Set(CONTEXT_STORE_MCP_TOOLS.map((t) => t.name));

/** `$OPENMEM_STATE_DIR/context` (trimmed), read at call time; same resolver as the hooks. */
export function contextRoot(env = process.env) {
  return hookContextRoot(env.HOME || os.homedir(), env);
}

/** Hook-side sanitization (docs/context-store.md). An explicit search id containing a path separator, or
 *  equal to `.`/`..`, is rejected: pointers hand the agent an already-sanitized id, which never has one. */
export function sanitizeSessionId(raw) {
  const text = String(raw ?? "");
  if (/[/\\]/.test(text) || /^\s*\.{1,2}\s*$/.test(text)) throw new Error(`invalid session_id: ${JSON.stringify(text)}`);
  let sid = "";
  try {
    sid = hookSanitizeSessionId(text);
  } catch {
    // empty after trimming
  }
  if (!sid) throw new Error(`invalid session_id: ${JSON.stringify(text)}`);
  return sid;
}

function gitRoot(dir) {
  let candidate = path.resolve(dir);
  while (true) {
    if (fs.existsSync(path.join(candidate, ".git"))) return candidate;
    const parent = path.dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
}

/** The repository's shared git dir: linked worktrees of one repo resolve to the same path. */
function repoIdentity(root) {
  if (!root) return null;
  const entry = path.join(root, ".git");
  try {
    if (fs.statSync(entry).isDirectory()) return fs.realpathSync(entry);
    const match = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(entry, "utf8"));
    if (!match) return null;
    const gitDir = path.resolve(root, match[1].trim());
    const common = path.join(gitDir, "commondir");
    const shared = fs.existsSync(common) ? path.resolve(gitDir, fs.readFileSync(common, "utf8").trim()) : gitDir;
    return fs.realpathSync(shared);
  } catch {
    return null;
  }
}

function readJsonFile(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function within(child, parent) {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`);
}

/** Registered sessions whose cwd lies in the workspace git root, equals cwd, or belongs to a linked
 *  worktree of the same repository, newest first. */
function workspaceSessions(sessionsDir, cwd) {
  let names;
  try {
    names = fs.readdirSync(sessionsDir);
  } catch {
    return [];
  }
  const here = path.resolve(cwd);
  const root = gitRoot(here);
  const repo = repoIdentity(root);
  const found = [];
  for (const file of names) {
    if (!file.endsWith(".json") || file.endsWith(".trim.json")) continue;
    const reg = readJsonFile(path.join(sessionsDir, file));
    if (!reg || typeof reg.cwd !== "string" || !path.isAbsolute(reg.cwd)) continue;
    const regCwd = path.resolve(reg.cwd);
    const sameRepo = repo && repoIdentity(gitRoot(regCwd)) === repo;
    if (!(regCwd === here || (root && within(regCwd, root)) || sameRepo)) continue;
    const at = Date.parse(reg.registered_at);
    found.push({ sid: file.slice(0, -".json".length), at: Number.isFinite(at) ? at : 0 });
  }
  return found.sort((a, b) => b.at - a.at).slice(0, MAX_SESSIONS).map((s) => s.sid);
}

function readLog(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === "object" && typeof row.text === "string") rows.push(row);
    } catch {
      /* skip malformed line */
    }
  }
  return rows;
}

function excerpt(text, at) {
  if (text.length <= EXCERPT_CHARS) return text;
  const start = Math.max(0, Math.min(at - Math.floor(EXCERPT_CHARS / 4), text.length - EXCERPT_CHARS));
  const end = start + EXCERPT_CHARS;
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function given(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function compilePattern(args) {
  const source = String(args.pattern);
  if (source.length > PATTERN_MAX_CHARS) throw new Error(`pattern must be at most ${PATTERN_MAX_CHARS} characters`);
  try {
    return new RegExp(source, args.ignore_case === true ? "i" : "");
  } catch (err) {
    throw new Error(`invalid pattern: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function contextCount(raw) {
  if (raw === undefined || raw === null) return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > CONTEXT_MAX) throw new Error(`context must be an integer from 0 to ${CONTEXT_MAX}`);
  return n;
}

/** Word hits: the number of distinct terms found and the first match offset. */
function termMatch(terms, text) {
  const lower = text.toLowerCase();
  let matched = 0;
  let first = Infinity;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0) {
      matched++;
      first = Math.min(first, i);
    }
  }
  return matched ? { matched, first } : null;
}

/**
 * Regex hits as [rowIndex, offset] pairs, scanning the first PATTERN_ROW_CHARS of each text.
 * Runs in a vm context so V8 interrupts catastrophic backtracking at the deadline; hits found
 * before the deadline are kept. Returns whether the deadline cut the scan short.
 */
function patternScan(re, texts, deadline, out) {
  const timeout = Math.floor(deadline - Date.now());
  if (timeout < 1) return true;
  const sandbox = { re, texts: texts.map((t) => t.slice(0, PATTERN_ROW_CHARS)), out };
  try {
    vm.runInNewContext("for (let i = 0; i < texts.length; i++) { const m = re.exec(texts[i]); if (m) out.push([i, m.index]); }", sandbox, {
      timeout,
    });
    return false;
  } catch (err) {
    if (err?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") return true;
    throw err;
  }
}

function rowSummary(row, text) {
  return { seq: row.seq ?? null, role: row.role ?? null, kind: row.kind ?? null, name: row.name ?? null, text };
}

function search(args, env, cwd) {
  const hasQuery = given(args.query);
  const hasPattern = args.pattern !== undefined && args.pattern !== null && String(args.pattern) !== "";
  if (hasQuery === hasPattern) throw new Error("pass exactly one of query or pattern");
  const re = hasPattern ? compilePattern(args) : null;
  const query = hasQuery ? String(args.query).trim() : null;
  const terms = hasQuery ? [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))] : [];
  const context = contextCount(args.context);
  const limit = Number(args.limit) > 0 ? Math.floor(Number(args.limit)) : DEFAULT_LIMIT;
  const sessionsDir = path.join(contextRoot(env), "sessions");
  const sessions = given(args.session_id) ? [sanitizeSessionId(args.session_id)] : workspaceSessions(sessionsDir, cwd);

  const deadline = Date.now() + PATTERN_BUDGET_MS;
  let timedOut = false;
  const hits = [];
  const logs = new Map();
  const logFiles = {};
  sessions.forEach((sid, sessionRank) => {
    const file = path.join(sessionsDir, `${sid}${LOG_SUFFIX}`);
    if (fs.existsSync(file)) logFiles[sid] = file;
    const rows = readLog(file).sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
    logs.set(sid, rows);
    const add = (index, matched, first) =>
      hits.push({ sid, sessionRank, index, row: rows[index], matched, first, seq: Number(rows[index].seq) || 0 });
    if (re) {
      if (timedOut) return;
      const found = [];
      timedOut = patternScan(re, rows.map((r) => r.text), deadline, found);
      for (const [index, at] of found) add(index, 1, at);
      return;
    }
    rows.forEach((row, index) => {
      const m = termMatch(terms, row.text);
      if (m) add(index, m.matched, m.first);
    });
  });
  hits.sort((a, b) => b.matched - a.matched || a.sessionRank - b.sessionRank || b.seq - a.seq);

  const envelope = {
    ...(re ? { pattern: String(args.pattern) } : { query }),
    sessions_searched: sessions,
    log_files: logFiles,
    total_matches: hits.length,
  };
  const overhead = JSON.stringify(envelope, null, 2).length;
  const results = [];
  let truncated = timedOut || hits.length > limit;
  for (const h of hits.slice(0, limit)) {
    const blobIds = [...new Set([...h.row.text.matchAll(BLOB_REF_RE)].map((m) => m[1]))];
    const rows = logs.get(h.sid);
    const neighbour = (r) => rowSummary(r, excerpt(r.text, 0));
    const item = {
      session_id: h.sid,
      ...rowSummary(h.row, excerpt(h.row.text, h.first)),
      ...(re ? {} : { matched_terms: h.matched }),
      ...(blobIds.length ? { blob_ids: blobIds } : {}),
      ...(context
        ? {
            before: rows.slice(Math.max(0, h.index - context), h.index).map(neighbour),
            after: rows.slice(h.index + 1, h.index + 1 + context).map(neighbour),
          }
        : {}),
    };
    if (overhead + JSON.stringify([...results, item], null, 2).length > RESULT_MAX_CHARS) {
      truncated = true;
      break;
    }
    results.push(item);
  }
  return {
    ...envelope,
    results,
    truncated,
    ...(timedOut ? { timed_out: true } : {}),
  };
}

function getBlob(args, env) {
  const id = String(args.id ?? "").trim();
  if (!BLOB_ID_RE.test(id)) throw new Error("id must be exactly 16 lowercase hex characters");
  const offset = Number(args.offset) > 0 ? Math.floor(Number(args.offset)) : 0;
  let text;
  try {
    text = fs.readFileSync(path.join(contextRoot(env), "blobs", `${id}.txt`), "utf8");
  } catch {
    return { id, found: false, text: "" };
  }
  const chunk = text.slice(offset, offset + BLOB_MAX_CHARS);
  const end = offset + chunk.length;
  return {
    id,
    found: true,
    total_chars: text.length,
    offset,
    text: chunk,
    truncated: end < text.length,
    ...(end < text.length ? { next_offset: end } : {}),
  };
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string }} [opts]
 */
export function callContextStoreTool(name, args = {}, opts = {}) {
  const env = opts.env || process.env;
  if (name === "smart_compact_search") return search(args, env, opts.cwd || process.cwd());
  if (name === "smart_compact_get") return getBlob(args, env);
  throw new Error(`unknown tool: ${name}`);
}
