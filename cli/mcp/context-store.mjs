/**
 * Provider-independent smart_compact_* tools: read the context proxy's handoff logs and blobs.
 * File layout and row shape follow docs/context-store.md. Local reads only; never writes.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_LIMIT = 8;
const MAX_SESSIONS = 20;
const RESULT_MAX_CHARS = 8000;
const EXCERPT_CHARS = 400;
const BLOB_MAX_CHARS = 100_000;
const BLOB_ID_RE = /^[0-9a-f]{16}$/;
const BLOB_REF_RE = /\[blob:([0-9a-f]{16})\]/g;
const SID_UNSAFE_RE = /[^A-Za-z0-9._-]/g;
const LOG_SUFFIX = ".log.jsonl";

export const CONTEXT_STORE_MCP_TOOLS = [
  {
    name: "smart_compact_search",
    title: "Search trimmed session context",
    description:
      "Search the handoff log of conversation turns the OpenMem context proxy trimmed from this or earlier sessions " +
      "(user and assistant text, tool calls, tool results) and return matching rows with an excerpt. " +
      "Use when an [openmem: continuing session …] pointer says earlier messages were trimmed and you need a detail from them; " +
      "pass that session_id. Without session_id it searches recent sessions registered under this workspace's git root. " +
      "Rows citing [blob:<id>] return blob_ids for smart_compact_get. Not durable project memory: use memory_recall for that. " +
      "Local files only; works with every provider. Read-only.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to find (case-insensitive; rows containing every word rank first)" },
        session_id: { type: "string", description: "Session id from the [openmem: continuing session …] pointer" },
        limit: { type: "number", description: `Max rows (default ${DEFAULT_LIMIT})` },
      },
      required: ["query"],
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

/** `$OPENMEM_STATE_DIR/context`, read at call time. */
export function contextRoot(env = process.env) {
  const home = env.HOME || os.homedir();
  const state = env.OPENMEM_STATE_DIR || path.join(home, ".local", "share", "openmem");
  return path.join(state, "context");
}

/** Contract sanitization; rejects ids that try to leave sessions/. */
export function sanitizeSessionId(raw) {
  const sid = String(raw ?? "").trim();
  if (!sid || /[/\\]/.test(sid) || sid.includes("..")) throw new Error(`invalid session_id: ${JSON.stringify(sid)}`);
  return sid.replace(SID_UNSAFE_RE, "_");
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

function search(args, env, cwd) {
  const query = String(args.query ?? "").trim();
  if (!query) throw new Error("query is required");
  const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
  const limit = Number(args.limit) > 0 ? Math.floor(Number(args.limit)) : DEFAULT_LIMIT;
  const sessionsDir = path.join(contextRoot(env), "sessions");
  const explicit = args.session_id !== undefined && args.session_id !== null && String(args.session_id).trim() !== "";
  const sessions = explicit ? [sanitizeSessionId(args.session_id)] : workspaceSessions(sessionsDir, cwd);

  const hits = [];
  sessions.forEach((sid, sessionRank) => {
    for (const row of readLog(path.join(sessionsDir, `${sid}${LOG_SUFFIX}`))) {
      const lower = row.text.toLowerCase();
      let matched = 0;
      let first = Infinity;
      for (const t of terms) {
        const i = lower.indexOf(t);
        if (i >= 0) {
          matched++;
          first = Math.min(first, i);
        }
      }
      if (matched) hits.push({ sid, sessionRank, row, matched, first, seq: Number(row.seq) || 0 });
    }
  });
  hits.sort((a, b) => b.matched - a.matched || a.sessionRank - b.sessionRank || b.seq - a.seq);

  const results = [];
  let truncated = hits.length > limit;
  for (const h of hits.slice(0, limit)) {
    const blobIds = [...new Set([...h.row.text.matchAll(BLOB_REF_RE)].map((m) => m[1]))];
    const item = {
      session_id: h.sid,
      seq: h.row.seq ?? null,
      role: h.row.role ?? null,
      kind: h.row.kind ?? null,
      name: h.row.name ?? null,
      matched_terms: h.matched,
      text: excerpt(h.row.text, h.first),
      ...(blobIds.length ? { blob_ids: blobIds } : {}),
    };
    if (JSON.stringify([...results, item], null, 2).length > RESULT_MAX_CHARS) {
      truncated = true;
      break;
    }
    results.push(item);
  }
  return { query, sessions_searched: sessions, total_matches: hits.length, results, truncated };
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
