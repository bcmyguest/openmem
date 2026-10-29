/**
 * Native context trimming for OpenCode 2: a port of the context proxy core (proxy/openmem_context/)
 * for OpenCode's LLM message shape. File layout, log rows and inserted text follow docs/context-store.md.
 *
 * OpenCode 2 message: { id?, role: "system" | "user" | "assistant" | "tool", content: Part[] }.
 * Parts: text {text}, media, tool-call {id, name, input}, tool-result {id, name, result}, reasoning {text},
 * compaction, effort. A tool result is { type: "text" | "json" | "error", value } or
 * { type: "content", value: [{ type: "text", text } | { type: "file", ... }] }.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { contextRoot, sanitizeSessionId } from "./context-store.mjs";

export const DEFAULT_TRIM_AT_TOKENS = 120000;
export const DEFAULT_COMPRESS_OVER_TOKENS = 4000;
export const DEFAULT_COMPACTION_MAX_CHARS = 12000;
export const DEFAULT_RECALL_TIMEOUT_S = 5.0;
export const MARKER_PREFIX = "[openmem: tool result compressed,";
const HEAD_LINES = 40;
const TAIL_LINES = 20;
const HEAD_CHARS = 4000;
const TAIL_CHARS = 2000;
const MAX_THREADS = 32;
const RECALL_QUERY_MAX_CHARS = 2000;
const TRIM_STATE_VERSION = 1;
const FORMAT = "opencode2";
/** Part types whose payload is binary; each is charged a flat 6400 characters (about 1600 tokens). */
const BINARY_BLOCK_TYPES = new Set(["image", "document", "input_image", "input_file", "image_url", "file", "media"]);
const BINARY_BLOCK_CHARS = 6400;
const BLOB_REF_RE = /smart_compact_get\(id="([0-9a-f]{16})"\)/;
const REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const SURROGATE_RE = /[\uD800-\uDFFF]/;
const locks = new Map();

// Python string semantics (code points), so the compressed form matches the proxy's byte for byte.
const cpLen = (s) => (SURROGATE_RE.test(s) ? Array.from(s).length : s.length);
const cpSlice = (s, start, end) => (SURROGATE_RE.test(s) ? Array.from(s).slice(start, end).join("") : s.slice(start, end));

/** Settings from the same environment variables as the proxy (proxy/openmem_context/settings.py). */
export function trimSettings(env = process.env, home = env.HOME) {
  const int = (name, fallback) => {
    const raw = String(env[name] ?? "").trim();
    return /^[+-]?\d+$/.test(raw) ? Number.parseInt(raw, 10) : fallback;
  };
  const float = (name, fallback) => {
    const raw = String(env[name] ?? "").trim();
    const value = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(value) ? value : fallback;
  };
  return {
    enabled: !["0", "false", "no", "off"].includes(String(env.CONTEXT_PROXY_ENABLED ?? "1").trim().toLowerCase()),
    trimAtTokens: int("CONTEXT_TRIM_AT_TOKENS", DEFAULT_TRIM_AT_TOKENS),
    compressOverTokens: int("CONTEXT_COMPRESS_OVER_TOKENS", DEFAULT_COMPRESS_OVER_TOKENS),
    compactionMaxChars: int("CONTEXT_COMPACTION_MAX_CHARS", DEFAULT_COMPACTION_MAX_CHARS),
    recallTimeoutS: float("CONTEXT_RECALL_TIMEOUT_S", DEFAULT_RECALL_TIMEOUT_S),
    contextDir: contextRoot(home, env),
  };
}

export function textTokens(text) {
  return Math.floor((cpLen(text) + 3) / 4);
}

function chars(value) {
  if (typeof value === "string") return cpLen(value);
  if (value === null || value === undefined) return 0;
  if (Array.isArray(value)) return value.reduce((sum, v) => sum + chars(v), 0);
  if (ArrayBuffer.isView(value)) return BINARY_BLOCK_CHARS;
  if (typeof value === "object") {
    if (BINARY_BLOCK_TYPES.has(value.type)) return BINARY_BLOCK_CHARS;
    return Object.entries(value).reduce((sum, [k, v]) => sum + k.length + chars(v), 0);
  }
  return String(value).length;
}

/** Characters / 4 over every value, as the proxy estimates request size. */
export function estimateTokens(...values) {
  return Math.floor((values.reduce((sum, v) => sum + chars(v), 0) + 3) / 4);
}

function canonical(value) {
  if (value === null || value === undefined) return value ?? null;
  if (ArrayBuffer.isView(value)) {
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return { $bytes: crypto.createHash("sha256").update(bytes).digest("hex") };
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    if (typeof value.toJSON === "function") return canonical(value.toJSON());
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = canonical(value[key]);
    }
    return out;
  }
  return value;
}

/** Stable hash of a message, ignoring key order and `cache` hints on the message and its parts. */
export function fingerprint(message) {
  const { cache: _c, ...rest } = message || {};
  const content = Array.isArray(rest.content)
    ? rest.content.map((part) => {
      if (!part || typeof part !== "object") return part;
      const { cache: _p, ...kept } = part;
      return kept;
    })
    : rest.content;
  const blob = JSON.stringify(canonical({ ...rest, content }));
  return crypto.createHash("sha256").update(blob, "utf8").digest("hex").slice(0, 32);
}

export function blobId(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/** `{compressed, id}` when text exceeds overTokens, else null. Same bytes as proxy compress_text. */
export function compressText(text, overTokens) {
  if (overTokens <= 0 || text.startsWith(MARKER_PREFIX)) return null;
  const tokens = textTokens(text);
  if (tokens <= overTokens) return null;
  const lines = text.split("\n");
  let head;
  let tail;
  if (lines.length > HEAD_LINES + TAIL_LINES) {
    head = cpSlice(lines.slice(0, HEAD_LINES).join("\n"), 0, HEAD_CHARS);
    tail = cpSlice(lines.slice(-TAIL_LINES).join("\n"), -TAIL_CHARS);
  } else {
    head = cpSlice(text, 0, HEAD_CHARS);
    tail = cpSlice(text, Math.max(HEAD_CHARS, cpLen(text) - TAIL_CHARS));
  }
  const id = blobId(text);
  const out = `${MARKER_PREFIX} ${tokens} tokens — smart_compact_get(id="${id}") returns the full text]\n${head}\n…\n${tail}`;
  if (cpLen(out) >= cpLen(text)) return null;
  return { compressed: out, id };
}

function compressedBlobId(text) {
  if (!text.startsWith(MARKER_PREFIX)) return null;
  return BLOB_REF_RE.exec(text.split("\n", 1)[0])?.[1] || null;
}

function logResultText(text) {
  const id = compressedBlobId(text);
  if (!id) return text;
  const newline = text.indexOf("\n");
  return newline >= 0 ? `[blob:${id}]\n${text.slice(newline + 1)}` : `[blob:${id}]`;
}

function compactJson(value) {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return value; }
  }
  return JSON.stringify(value ?? null);
}

export function stripReminders(text) {
  return text.replace(REMINDER_RE, "").trim();
}

// OpenCode 2 message rules (the proxy's adapter interface).
const parts = (message) => (Array.isArray(message?.content) ? message.content : []);
export const isPinned = (message) => message?.role === "system";
export function isTurnStart(message) {
  if (message?.role !== "user") return false;
  const content = parts(message);
  return content.length > 0 && !content.some((p) => p?.type === "tool-result");
}
/** A user message that is not only tool results; the first one is pinned through every trim. */
export function isFirstUser(message) {
  return message?.role === "user" && parts(message).some((p) => p?.type !== "tool-result");
}
/** Index of the first real user turn, or null. */
export function firstUserIndex(items) {
  const i = items.findIndex(isFirstUser);
  return i >= 0 ? i : null;
}
const callIds = (message) => new Set(parts(message).filter((p) => p?.type === "tool-call").map((p) => p.id).filter((id) => id != null));
const resultIds = (message) => new Set(parts(message).filter((p) => p?.type === "tool-result").map((p) => p.id).filter((id) => id != null));

export function userText(message) {
  return parts(message).map((p) => (p?.type === "text" ? String(p.text ?? "") : `[${p?.type || "part"}]`)).join("\n");
}

function resultText(result) {
  if (!result || typeof result !== "object") return "";
  if (result.type === "content") {
    return (Array.isArray(result.value) ? result.value : [])
      .map((item) => (item?.type === "text" ? String(item.text ?? "") : `[${item?.type || "part"}]`)).join("\n");
  }
  return typeof result.value === "string" ? result.value : compactJson(result.value);
}

/** Compressed copy of a message's tool results; calls onBlob(id, fullText) for each. Returns the input when unchanged. */
export function compressMessage(message, overTokens, onBlob) {
  const content = parts(message);
  let next = null;
  content.forEach((part, i) => {
    if (part?.type !== "tool-result") return;
    const result = part.result;
    let text = null;
    if (result?.type === "text" && typeof result.value === "string") text = result.value;
    else if (result?.type === "content" && Array.isArray(result.value) && result.value.length
      && result.value.every((item) => item?.type === "text")) text = result.value.map((item) => String(item.text ?? "")).join("\n");
    if (text === null) return;
    const res = compressText(text, overTokens);
    if (!res) return;
    onBlob(res.id, text);
    next ??= [...content];
    next[i] = {
      ...part,
      result: result.type === "text" ? { ...result, value: res.compressed } : { type: "content", value: [{ type: "text", text: res.compressed }] },
    };
  });
  return next ? { ...message, content: next } : message;
}

/**
 * The note becomes its own leading text part. It ends in a blank line because OpenAI-compatible
 * lowering joins a message's text parts with no separator (observed with OpenCode 2.2.1); the
 * proxy's Chat adapter uses the same "\n\n" for string content.
 */
export function prependNote(message, note) {
  return { ...message, content: [{ type: "text", text: `${note}\n\n` }, ...parts(message)] };
}

function logRows(message, names) {
  const role = message.role === "assistant" ? "assistant" : message.role === "tool" ? "tool" : "user";
  const out = [];
  for (const part of parts(message)) {
    if (!part || typeof part !== "object") continue;
    switch (part.type) {
      case "text": out.push([role, "text", null, String(part.text ?? "")]); break;
      case "tool-call": out.push(["assistant", "tool_use", part.name ?? null, compactJson(part.input ?? {})]); break;
      case "tool-result":
        out.push(["tool", "tool_result", part.name ?? names.get(part.id) ?? null, logResultText(resultText(part.result))]);
        break;
      case "reasoning": if (part.text) out.push(["assistant", "thinking", null, String(part.text)]); break;
      case "compaction": out.push([role, "text", null, typeof part.text === "string" ? part.text : "[compaction]"]); break;
      default: out.push([role, "text", null, `[${part.type}]`]);
    }
  }
  return out;
}

function toolNames(items) {
  const names = new Map();
  for (const item of items) for (const p of parts(item)) if (p?.type === "tool-call") names.set(p.id, p.name);
  return names;
}

/** Log rows for items[start, stop), skipping pinned messages and the index `skip` (the pinned first user turn). */
function rows(items, start, stop, ts, skip = null) {
  const names = toolNames(items);
  const out = [];
  for (let j = start; j < Math.min(stop, items.length); j++) {
    if (j === skip || isPinned(items[j])) continue;
    for (const [role, kind, name, text] of logRows(items[j], names)) out.push({ ts, role, kind, name, text });
  }
  return out;
}

const droppable = (items, stop, first) => items.slice(0, stop).filter((x, j) => j !== first && !isPinned(x));

/**
 * Index of the last real user turn > after whose kept part shares no call/result pair with the dropped part.
 * The kept part is the suffix from the cut plus the pinned first user turn.
 */
export function chooseCut(items, after, first = null) {
  const union = (list, fn) => new Set(list.flatMap((x) => [...fn(x)]));
  for (let i = items.length - 1; i > after; i--) {
    if (!isTurnStart(items[i])) continue;
    const dropped = droppable(items, i, first);
    if (!dropped.length) return null;
    const kept = first !== null && first < i ? [...items.slice(i), items[first]] : items.slice(i);
    const dCalls = union(dropped, callIds);
    const dResults = union(dropped, resultIds);
    const kCalls = union(kept, callIds);
    const kResults = union(kept, resultIds);
    if ([...dCalls].some((id) => kResults.has(id)) || [...kCalls].some((id) => dResults.has(id))) continue;
    return i;
  }
  return null;
}

/**
 * Pinned messages and the first user turn before the cut (in order), then the noted cut turn and the rest.
 * `decorate(message)` adds per-message parts at render time only; trimming, fingerprints and log rows
 * always see the undecorated messages.
 */
export function render(items, cut, note, first = null, decorate = (m) => m) {
  if (!cut) return items.map(decorate);
  const head = items.slice(0, cut).filter((x, j) => j === first || isPinned(x));
  return [...head.map(decorate), prependNote(decorate(items[cut]), note), ...items.slice(cut + 1).map(decorate)];
}

function locateCut(items, thread) {
  const { cut, cut_fp: want } = thread;
  if (Number.isInteger(cut) && cut > 0 && cut < items.length && fingerprint(items[cut]) === want) return cut;
  for (let i = 1; i < items.length; i++) if (fingerprint(items[i]) === want) return i;
  return 0;
}

export function pointerText(sid, dropped, logPath) {
  return `[openmem: continuing session ${sid}; ${dropped} earlier messages trimmed. `
    + `Use smart_compact_search(session_id="${sid}", query=...) for anything earlier; `
    + `the handoff log is ${logPath} (JSONL, one row per block).]`;
}

export function pendingText(sid) {
  return "[openmem: memory ingest is still running, so the most recent turns may not be in memory yet. "
    + `Use smart_compact_search(session_id="${sid}", query=...) for them.]`;
}

const utcNow = (now = new Date()) => now.toISOString().replace(/\.\d{3}Z$/, "Z");

/** json.dumps with Python's default separators (", ", ": "). */
function pyDumps(value, sortKeys = false) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((v) => pyDumps(v, sortKeys)).join(", ")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined);
  if (sortKeys) keys.sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}: ${pyDumps(value[k], sortKeys)}`).join(", ")}}`;
}

/** Context store files (docs/context-store.md). Directories 700, files 600. */
export class Store {
  constructor(root) {
    this.root = root;
    this.sessions = path.join(root, "sessions");
    this.blobs = path.join(root, "blobs");
  }

  file(sid, suffix) { return path.join(this.sessions, `${sid}${suffix}`); }

  ensure(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* not ours */ }
  }

  writeAtomic(file, data) {
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
    try {
      fs.writeFileSync(temporary, data, { mode: 0o600 });
      fs.renameSync(temporary, file);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch { /* already gone */ }
      throw error;
    }
  }

  registration(sid) {
    try {
      const value = JSON.parse(fs.readFileSync(this.file(sid, ".json"), "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value : null;
    } catch { return null; }
  }

  forceRequested(sid) { return fs.existsSync(this.file(sid, ".force")); }

  clearForce(sid) {
    try { fs.unlinkSync(this.file(sid, ".force")); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }

  /** Trim state with threads as an insertion-ordered Map. */
  loadTrim(sid) {
    let value = null;
    try { value = JSON.parse(fs.readFileSync(this.file(sid, ".trim.json"), "utf8")); } catch { /* fresh */ }
    if (!value || typeof value !== "object" || value.version !== TRIM_STATE_VERSION) return { version: TRIM_STATE_VERSION, threads: new Map() };
    const threads = value.threads && typeof value.threads === "object" && !Array.isArray(value.threads) ? value.threads : {};
    return { ...value, threads: new Map(Object.entries(threads)) };
  }

  saveTrim(sid, state) {
    this.ensure(this.sessions);
    const plain = { ...state, threads: Object.fromEntries(state.threads) };
    this.writeAtomic(this.file(sid, ".trim.json"), pyDumps(plain, true));
  }

  nextSeq(sid) {
    let fd;
    try { fd = fs.openSync(this.file(sid, ".log.jsonl"), "r"); } catch (error) {
      if (error?.code === "ENOENT") return 0;
      throw error;
    }
    try {
      const size = fs.fstatSync(fd).size;
      for (let chunk = 65536; ; chunk *= 4) {
        const start = Math.max(0, size - chunk);
        const buffer = Buffer.alloc(size - start);
        fs.readSync(fd, buffer, 0, buffer.length, start);
        const lines = buffer.toString("utf8").split("\n").filter((line) => line.trim());
        const complete = start === 0 ? lines : lines.slice(1);
        for (const line of complete.reverse()) {
          try {
            const seq = JSON.parse(line).seq;
            if (Number.isInteger(seq)) return seq + 1;
          } catch { /* skip */ }
        }
        if (start === 0) return 0;
      }
    } finally { fs.closeSync(fd); }
  }

  /** Append rows (without seq); assigns seq and returns the number written. */
  appendLog(sid, list) {
    if (!list.length) return 0;
    this.ensure(this.sessions);
    let seq = this.nextSeq(sid);
    const text = list.map((row) => pyDumps({ seq: seq++, ...row })).join("\n");
    fs.appendFileSync(this.file(sid, ".log.jsonl"), `${text}\n`, { mode: 0o600 });
    return list.length;
  }

  writeBlob(id, text) {
    const file = path.join(this.blobs, `${id}.txt`);
    if (fs.existsSync(file)) return;
    this.ensure(this.blobs);
    this.writeAtomic(file, text);
  }
}

/** Serialize work per session; the plugin process may run hooks for one session concurrently. */
export async function withSessionLock(sid, fn) {
  const previous = locks.get(sid) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const chained = previous.then(() => current);
  locks.set(sid, chained);
  await previous;
  try { return await fn(); } finally {
    release();
    if (locks.get(sid) === chained) locks.delete(sid);
  }
}

/** One stderr line: exception type and location only, never message content. */
export function logFailOpen(error) {
  const frame = String(error?.stack || "").split("\n").find((line) => /^\s+at /.test(line)) || "";
  const where = /([^/\\(\s]+:\d+)(?::\d+)?\)?\s*$/.exec(frame)?.[1] || "?";
  process.stderr.write(`openmem-context: fail-open ${error?.name || typeof error} at ${where}\n`);
}


/**
 * Pointer + recall + ingest note for a cut at items[cut].
 * deps.recall(bank, query, maxChars) and deps.pending(bank) are best effort.
 */
async function buildNote(items, cut, sid, dropped, store, settings, deps) {
  const out = [pointerText(sid, dropped, store.file(sid, ".log.jsonl"))];
  const bank = store.registration(sid)?.bank;
  if (typeof bank === "string" && bank) {
    const query = cpSlice(stripReminders(userText(items[cut])), 0, RECALL_QUERY_MAX_CHARS);
    if (query && deps.recall) {
      try {
        const text = cpSlice(String((await deps.recall(bank, query, settings.compactionMaxChars)) || ""), 0, settings.compactionMaxChars);
        if (text) out.push(`[openmem recall]\n${text}`);
      } catch (error) { logFailOpen(error); }
    }
    if (deps.pending) {
      try { if (await deps.pending(bank)) out.push(pendingText(sid)); } catch (error) { logFailOpen(error); }
    }
  }
  return out.join("\n");
}

function compressAll(messages, settings, store) {
  if (settings.compressOverTokens <= 0) return messages;
  return messages.map((m) => compressMessage(m, settings.compressOverTokens, (id, text) => store.writeBlob(id, text)));
}

const validMessages = (messages) => Array.isArray(messages) && messages.length > 0
  && messages.every((m) => m && typeof m === "object" && !Array.isArray(m));

/** Contract session id, or null when the id is empty after trimming. */
function sessionIdOf(request) {
  try { return sanitizeSessionId(request.sessionID); } catch { return null; }
}

/**
 * Context-hook rewrite: compression, sticky trim, recall note. Returns the messages to send
 * (the input array itself when nothing changed). `deps.decorate(message)` adds render-only parts
 * (see render).
 * @param {{ sessionID: string, system?: unknown, tools?: unknown, messages: object[] }} request
 */
export async function trimContext(request, settings, deps = {}) {
  const original = request.messages;
  if (!settings.enabled || !validMessages(original)) return original;
  const sid = sessionIdOf(request);
  if (!sid) return original;
  const store = new Store(settings.contextDir);
  const items = compressAll(original, settings, store);
  const roots = items.filter((m) => !isPinned(m));
  if (!roots.length) return original;
  const root = fingerprint(roots[0]);
  const first = firstUserIndex(items);
  const decorate = deps.decorate || ((m) => m);

  const view = await withSessionLock(sid, async () => {
    const state = store.loadTrim(sid);
    const { threads } = state;
    const thread = threads.get(root);
    let cut = 0;
    let note = null;
    if (thread) {
      cut = locateCut(items, thread);
      note = cut ? thread.note : null;
      if (!cut) threads.delete(root);
    }
    let rendered = render(items, cut, note, first, decorate);
    const force = store.forceRequested(sid);
    if (force || estimateTokens(request.system, request.tools, rendered) >= settings.trimAtTokens) {
      const next = chooseCut(items, cut, first);
      if (next !== null) {
        const ts = utcNow(deps.now?.());
        store.appendLog(sid, rows(items, cut, next, ts, first));
        note = await buildNote(items, next, sid, droppable(items, next, first).length, store, settings, deps);
        threads.delete(root);
        threads.set(root, { cut: next, cut_fp: fingerprint(items[next]), note, format: FORMAT, updated: ts });
        while (threads.size > MAX_THREADS) threads.delete(threads.keys().next().value);
        store.saveTrim(sid, state);
        if (force) store.clearForce(sid);
        rendered = render(items, next, note, first, decorate);
      } else if (thread && !cut) store.saveTrim(sid, state);
    } else if (thread && !cut) store.saveTrim(sid, state);
    return rendered;
  });
  return view.length === original.length && view.every((m, i) => m === original[i]) ? original : view;
}

/**
 * First index not yet in the log for a compaction. Trims logged items[0, cut) except the pinned first
 * user turn. When the stored cut message is no longer in the history, the stored cut index stands in
 * for it, so earlier rows are not logged twice.
 */
function loggedUpTo(items, thread) {
  if (!thread) return 0;
  const located = locateCut(items, thread);
  if (located) return located;
  return Number.isInteger(thread.cut) && thread.cut > 0 ? Math.min(thread.cut, items.length) : 0;
}

/**
 * Compaction-hook result: log everything not yet logged, then return the pointer + recall summary
 * that replaces OpenCode's model-written summary. Null when there is nothing to compact.
 */
export async function compactionSummary(request, settings, deps = {}) {
  const original = request.messages;
  if (!validMessages(original)) return null;
  const sid = sessionIdOf(request);
  if (!sid) return null;
  const store = new Store(settings.contextDir);
  const items = compressAll(original, settings, store);
  const roots = items.filter((m) => !isPinned(m));
  if (!roots.length) return null;
  const root = fingerprint(roots[0]);
  const first = firstUserIndex(items);
  return withSessionLock(sid, async () => {
    const state = store.loadTrim(sid);
    const thread = state.threads.get(root);
    const start = loggedUpTo(items, thread);
    const ts = utcNow(deps.now?.());
    // Compaction drops the pinned first user turn too; trims never logged it.
    const pinned = thread && first !== null && first < start ? rows(items, first, first + 1, ts) : [];
    store.appendLog(sid, [...pinned, ...rows(items, start, items.length, ts)]);
    let last = -1;
    for (let i = items.length - 1; i >= 0; i--) if (isTurnStart(items[i])) { last = i; break; }
    const note = last >= 0
      ? await buildNote(items, last, sid, roots.length, store, settings, deps)
      : pointerText(sid, roots.length, store.file(sid, ".log.jsonl"));
    if (thread) {
      state.threads.delete(root);
      store.saveTrim(sid, state);
    }
    return note;
  });
}
