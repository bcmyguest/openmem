/**
 * Per-session SQLite store `sessions/<sid>.db` (docs/context-store.md, "Session database"): the JS side of
 * proxy/openmem_context/sessiondb.py, ttl.py and embed.py. The schema and row rules must match the Python
 * byte for byte (scripts/tests/test_context_parity.mjs).
 *
 * node:sqlite is loaded on first use, so modules that import this one (hooks among them) never load it
 * unless they touch a database. Node >= 24 (engines.node; node:sqlite with FTS5 first shipped in 22.16).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SCHEMA_VERSION = 1;
/** Executed in order on an empty database, then PRAGMA user_version. Same strings as SCHEMA in sessiondb.py. */
export const SCHEMA = [
  "CREATE TABLE messages (seq INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, thread TEXT NOT NULL, "
    + "role TEXT NOT NULL, kind TEXT NOT NULL, name TEXT, text TEXT NOT NULL, blob_id TEXT, "
    + "in_context INTEGER NOT NULL DEFAULT 1, trimmed_at_seq INTEGER, trimmed_at TEXT, created_at TEXT NOT NULL)",
  "CREATE INDEX messages_thread ON messages (thread, seq)",
  "CREATE TABLE lines (id INTEGER PRIMARY KEY, message_seq INTEGER NOT NULL REFERENCES messages (seq), "
    + "line_no INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, UNIQUE (message_seq, line_no))",
  "CREATE VIRTUAL TABLE messages_fts USING fts5 (text, content='messages', content_rowid='seq')",
  "CREATE VIRTUAL TABLE lines_fts USING fts5 (text, content='lines', content_rowid='id')",
  "CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN "
    + "INSERT INTO messages_fts (rowid, text) VALUES (new.seq, new.text); END",
  "CREATE TRIGGER lines_fts_insert AFTER INSERT ON lines BEGIN "
    + "INSERT INTO lines_fts (rowid, text) VALUES (new.id, new.text); END",
  "CREATE TABLE vectors (message_seq INTEGER NOT NULL REFERENCES messages (seq), model TEXT NOT NULL, "
    + "dim INTEGER NOT NULL, blob BLOB NOT NULL, PRIMARY KEY (message_seq, model))",
];
export const DB_SUFFIX = ".db";
export const BUSY_TIMEOUT_MS = 1000;
export const DEFAULT_TTL_DAYS = 30;
export const DEFAULT_EMBEDDING_URL = "http://127.0.0.1:11434/v1";
/** Characters of a row's text sent for embedding (embed.py EMBED_MAX_CHARS). */
export const EMBED_MAX_CHARS = 8000;
const EMBED_BATCH = 32;
const EMBED_RETRY_MS = 60_000;
const EMBED_TIMEOUT_MS = 30_000;
const MAX_OPEN = 16;
const DAY_MS = 86_400_000;
export const TTL_STAMP = ".ttl-stamp";
/** Longest first, so `x.trim.json` groups under `x` (ttl.py SESSION_SUFFIXES). */
const SESSION_SUFFIXES = [".log.jsonl", ".trim.json", ".db-wal", ".db-shm", ".force", ".json", ".db"];
const BLOB_REF_RE = /^\[blob:([0-9a-f]{16})\]/;
const open = new Map();
const embedState = new Map();

/** node:sqlite, loaded on first use. */
export function sqlite() {
  return process.getBuiltinModule("node:sqlite");
}

/** Blob id named by a stored tool-result text ("[blob:<id>]..."), else null. */
export function blobRef(text) {
  return typeof text === "string" ? BLOB_REF_RE.exec(text)?.[1] ?? null : null;
}

/** Python fingerprint() of {prev, role, kind, name, text}: sorted keys, compact JSON, SHA-256, 32 hex. */
function rowFingerprint(prev, row) {
  const blob = JSON.stringify({ kind: row.kind, name: row.name ?? null, prev, role: row.role, text: row.text });
  return crypto.createHash("sha256").update(blob, "utf8").digest("hex").slice(0, 32);
}

/**
 * Give each row its fingerprint and thread, in order, in place (sessiondb.chain). A row's fingerprint hashes
 * the previous row's fingerprint with its own role, kind, name and text: a resent history yields the same
 * keys, and the same text said twice yields two rows. thread is the first row's fingerprint.
 */
export function chain(rows) {
  let prev = "";
  for (const row of rows) {
    prev = row.fingerprint = rowFingerprint(prev, row);
    row.thread = rows[0].fingerprint;
  }
  return rows;
}

function ensureFile(file) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* not ours */ }
  if (!fs.existsSync(file)) fs.closeSync(fs.openSync(file, "a", 0o600));
}

/** Writer connection in WAL mode with the schema in place; throws on a database of another schema version. */
export function connect(file) {
  ensureFile(file);
  const { DatabaseSync } = sqlite();
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    const version = () => db.prepare("PRAGMA user_version").get().user_version;
    if (version() === 0) {
      db.exec("BEGIN IMMEDIATE");
      try {
        if (version() === 0) {
          for (const ddl of SCHEMA) db.exec(ddl);
          db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    if (version() !== SCHEMA_VERSION) throw new Error(`unsupported session database user_version ${version()}`);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

function identity(file) {
  try {
    const st = fs.statSync(file);
    return `${st.dev}:${st.ino}`;
  } catch { return null; }
}

/** One session's database plus an index of its rows (fingerprint -> [seq, in_context]). */
export class SessionDB {
  constructor(file) {
    this.file = file;
    this.db = connect(file);
    this.identity = identity(file);
    this.known = new Map();
    this.dataVersion = null;
  }

  close() {
    try { this.db.close(); } catch { /* already closed */ }
  }

  refresh() {
    const version = this.db.prepare("PRAGMA data_version").get().data_version;
    if (version === this.dataVersion) return;
    this.known = new Map(this.db.prepare("SELECT fingerprint, seq, in_context FROM messages").all()
      .map((r) => [r.fingerprint, [r.seq, r.in_context]]));
    this.dataVersion = version;
  }

  /**
   * Store chained rows and their in_context flags (sessiondb.SessionDB.sync); returns the number of new rows.
   * rows: {fingerprint, thread, role, kind, name, text, blob_id, keep}; cutRow: index of the cut turn's first row or null.
   */
  sync(rows, cutRow, ts) {
    this.refresh();
    const { known, db } = this;
    const fresh = rows.filter((r) => !known.has(r.fingerprint));
    const changes = rows.some((r) => known.has(r.fingerprint) && known.get(r.fingerprint)[1] !== (r.keep ? 1 : 0));
    if (!fresh.length && !changes) return 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      let added = 0;
      const insert = db.prepare("INSERT INTO messages (fingerprint, thread, role, kind, name, text, blob_id, created_at) "
        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (fingerprint) DO NOTHING");
      const insertLine = db.prepare("INSERT INTO lines (message_seq, line_no, role, text) VALUES (?, ?, ?, ?)");
      for (const r of fresh) {
        const res = insert.run(r.fingerprint, r.thread, r.role, r.kind, r.name ?? null, r.text, r.blob_id ?? null, ts);
        if (res.changes === 1) {
          const seq = Number(res.lastInsertRowid);
          r.text.split("\n").forEach((line, i) => insertLine.run(seq, i + 1, r.role, line));
          known.set(r.fingerprint, [seq, 1]);
          added++;
        } else {
          const row = db.prepare("SELECT seq, in_context FROM messages WHERE fingerprint = ?").get(r.fingerprint);
          known.set(r.fingerprint, [row.seq, row.in_context]);
        }
      }
      const cutSeq = cutRow === null || cutRow === undefined ? null : known.get(rows[cutRow].fingerprint)[0];
      const back = db.prepare("UPDATE messages SET in_context = 1, trimmed_at_seq = NULL, trimmed_at = NULL WHERE seq = ?");
      const out = db.prepare("UPDATE messages SET in_context = 0, trimmed_at_seq = ?, trimmed_at = ? WHERE seq = ?");
      for (const r of rows) {
        const entry = known.get(r.fingerprint);
        const want = r.keep ? 1 : 0;
        if (entry[1] === want) continue;
        if (want) back.run(entry[0]);
        else out.run(cutSeq, ts, entry[0]);
        entry[1] = want;
      }
      db.exec("COMMIT");
      this.dataVersion = db.prepare("PRAGMA data_version").get().data_version;
      return added;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* no transaction */ }
      this.dataVersion = null;
      throw error;
    }
  }
}

/** Cached SessionDB for file; reopened when the file was deleted or replaced (TTL cleanup). */
export function openSession(file) {
  let entry = open.get(file);
  open.delete(file);
  if (entry && entry.identity !== identity(file)) {
    entry.close();
    entry = null;
  }
  entry ||= new SessionDB(file);
  open.set(file, entry);
  while (open.size > MAX_OPEN) {
    const [key, oldest] = open.entries().next().value;
    open.delete(key);
    oldest.close();
  }
  return entry;
}

/** Forget a cached connection after an error, so the next request reopens it. */
export function dropSession(file) {
  const entry = open.get(file);
  open.delete(file);
  entry?.close();
}

// Vectors: float32 little-endian, brute-force cosine (sessions hold thousands of rows).
export function packVector(values) {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => buffer.writeFloatLE(v, i * 4));
  return buffer;
}

export function unpackVector(blob, dim) {
  const buffer = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  return Array.from({ length: dim }, (_, i) => buffer.readFloatLE(i * 4));
}

export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/**
 * [seq, similarity] of the k vectors of `model` closest to query, best first, ties by seq (sessiondb.nearest).
 * `where` / `params` narrow the rows through the joined messages table `m`.
 */
export function nearest(db, query, model, k, where = "", params = []) {
  const rows = db.prepare(`SELECT v.message_seq AS seq, v.dim AS dim, v.blob AS blob FROM vectors v `
    + `JOIN messages m ON m.seq = v.message_seq WHERE v.model = ?${where ? ` AND ${where}` : ""}`).all(model, ...params);
  return rows.filter((r) => r.dim === query.length)
    .map((r) => [r.seq, cosine(query, unpackVector(r.blob, r.dim))])
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, k);
}

/** Vectors for texts from an OpenAI-compatible POST <url>/embeddings, in input order. */
export async function fetchEmbeddings({ url, model, apiKey }, texts, fetchFn = globalThis.fetch) {
  const response = await fetchFn(`${String(url).replace(/\/+$/, "")}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ model, input: texts }),
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`embeddings HTTP ${response.status}`);
  const payload = await response.json();
  const data = [...(payload?.data || [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const vectors = data.map((d) => d.embedding.map(Number));
  if (vectors.length !== texts.length) throw new Error("embedding count mismatch");
  return vectors;
}

/** Embed every row of an open SessionDB that lacks a `model` vector (embed.py embed_pending); returns rows stored. */
export async function embedPending(session, config, fetchFn) {
  let stored = 0;
  for (;;) {
    const rows = session.db.prepare("SELECT m.seq AS seq, m.text AS text FROM messages m LEFT JOIN vectors v "
      + "ON v.message_seq = m.seq AND v.model = ? WHERE v.message_seq IS NULL AND length(trim(m.text)) > 0 "
      + "ORDER BY m.seq LIMIT ?").all(config.model, EMBED_BATCH);
    if (!rows.length) return stored;
    const vectors = await fetchEmbeddings(config, rows.map((r) => Array.from(r.text).slice(0, EMBED_MAX_CHARS).join("")), fetchFn);
    const insert = session.db.prepare("INSERT OR IGNORE INTO vectors (message_seq, model, dim, blob) VALUES (?, ?, ?, ?)");
    session.db.exec("BEGIN IMMEDIATE");
    try {
      rows.forEach((r, i) => insert.run(r.seq, config.model, vectors[i].length, packVector(vectors[i])));
      session.db.exec("COMMIT");
    } catch (error) {
      session.db.exec("ROLLBACK");
      throw error;
    }
    stored += rows.length;
  }
}

/**
 * Embed a session's new rows in the background: at most one run per database at a time, retried no sooner
 * than a minute after a failure. Returns the run's promise (resolves to rows stored, or 0); never rejects.
 */
export function scheduleEmbedding(file, config, { fetchFn, onError } = {}) {
  if (!config?.model || !config?.url) return Promise.resolve(0);
  const state = embedState.get(file) || { running: null, again: false, retryAt: 0 };
  embedState.set(file, state);
  if (Date.now() < state.retryAt) return Promise.resolve(0);
  if (state.running) {
    state.again = true;
    return state.running;
  }
  state.running = (async () => {
    let total = 0;
    try {
      do {
        state.again = false;
        total += await embedPending(openSession(file), config, fetchFn);
      } while (state.again);
    } catch (error) {
      state.retryAt = Date.now() + EMBED_RETRY_MS;
      onError?.(error);
    } finally {
      state.running = null;
    }
    return total;
  })();
  return state.running;
}

/** [sid, suffix] for a session file name, or null for anything else (ttl.py session_of). */
export function sessionOf(name) {
  if (name.startsWith(".")) return null;
  const suffix = SESSION_SUFFIXES.find((s) => name.endsWith(s) && name.length > s.length);
  return suffix ? [name.slice(0, -suffix.length), suffix] : null;
}

/** Delete every session whose newest file is older than ttlDays (ttl.py sweep); returns the deleted sids, sorted. */
export function sweepContextStore(root, ttlDays, now = Date.now()) {
  if (!(ttlDays > 0)) return [];
  const dir = path.join(root, "sessions");
  let names;
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const groups = new Map();
  for (const entry of names) {
    const parsed = sessionOf(entry.name);
    if (!parsed || !entry.isFile()) continue;
    const file = path.join(dir, entry.name);
    let mtime;
    try { mtime = fs.lstatSync(file).mtimeMs; } catch { continue; }
    const group = groups.get(parsed[0]) || { newest: 0, files: [] };
    group.newest = Math.max(group.newest, mtime);
    group.files.push(file);
    groups.set(parsed[0], group);
  }
  const cutoff = now - ttlDays * DAY_MS;
  const deleted = [];
  for (const [sid, group] of groups) {
    if (group.newest >= cutoff) continue;
    for (const file of group.files) {
      try { fs.unlinkSync(file); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
    deleted.push(sid);
  }
  return deleted.sort();
}

/** sweepContextStore at most once a day, recorded by the mtime of <root>/.ttl-stamp (ttl.py maybe_sweep). */
export function maybeSweepContextStore(root, ttlDays, now = Date.now()) {
  if (!(ttlDays > 0)) return [];
  const stamp = path.join(root, TTL_STAMP);
  try {
    if (now - fs.statSync(stamp).mtimeMs < DAY_MS) return [];
  } catch (error) {
    if (error?.code !== "ENOENT") return [];
  }
  try {
    if (!fs.statSync(root).isDirectory()) return [];
  } catch { return []; }
  fs.closeSync(fs.openSync(stamp, "a", 0o600));
  fs.utimesSync(stamp, now / 1000, now / 1000);
  return sweepContextStore(root, ttlDays, now);
}

/**
 * Store settings from the environment (the proxy's Settings): CONTEXT_STORE_TTL_DAYS (default 30, 0 keeps
 * everything), CONTEXT_EMBEDDING_MODEL (empty turns vectors off), CONTEXT_EMBEDDING_URL, CONTEXT_EMBEDDING_API_KEY.
 */
export function storeSettings(env = process.env) {
  const ttl = String(env.CONTEXT_STORE_TTL_DAYS ?? "").trim();
  return {
    ttlDays: /^[+-]?\d+$/.test(ttl) ? Number.parseInt(ttl, 10) : DEFAULT_TTL_DAYS,
    embeddingModel: String(env.CONTEXT_EMBEDDING_MODEL ?? "").trim(),
    embeddingUrl: (String(env.CONTEXT_EMBEDDING_URL ?? "").trim() || DEFAULT_EMBEDDING_URL).replace(/\/+$/, ""),
    embeddingApiKey: String(env.CONTEXT_EMBEDDING_API_KEY ?? "").trim(),
  };
}
