/** Hook side of the context store contract (docs/context-store.md). */
import fs from "node:fs";
import path from "node:path";

/** Marker in the installed smart-compact command body; survives command expansion. */
export const SMART_COMPACT_MARKER = "openmem:smart-compact";
const SMART_COMPACT_PREFIX = /^\s*\/smart-compact(?:\s|$)/;
const SMART_COMPACT_TAG = "<command-name>/smart-compact</command-name>";

/** `$OPENMEM_STATE_DIR/context`, default `~/.local/share/openmem/context`. */
export function contextRoot(home, env = process.env) {
  const state = String(env.OPENMEM_STATE_DIR || "").trim() || path.join(home, ".local", "share", "openmem");
  return path.join(state, "context");
}

/** Session id with every character outside `[A-Za-z0-9._-]` replaced by `_`. */
export function sanitizeSessionId(sessionId) {
  return String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_");
}

function sessionsDir(home, env) {
  const root = contextRoot(home, env);
  const dir = path.join(root, "sessions");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  fs.chmodSync(dir, 0o700);
  return dir;
}

function writePrivate(file, text) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

/** Write `sessions/<sid>.json`. Returns the path, or null without a session id. */
export function registerSession({ home, env, sessionId, agent, cwd, bank, now = new Date() }) {
  if (!sessionId) return null;
  const sid = sanitizeSessionId(sessionId);
  const file = path.join(sessionsDir(home, env), `${sid}.json`);
  const registration = {
    session_id: sid,
    agent,
    cwd,
    bank,
    registered_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
  writePrivate(file, `${JSON.stringify(registration)}\n`);
  return file;
}

/** Write the empty `sessions/<sid>.force` flag. Returns the path, or null without a session id. */
export function writeForceFlag({ home, env, sessionId }) {
  if (!sessionId) return null;
  const file = path.join(sessionsDir(home, env), `${sanitizeSessionId(sessionId)}.force`);
  writePrivate(file, "");
  return file;
}

/** True for `/smart-compact …`, Claude Code's command tag, or the expanded command body. */
export function isSmartCompactPrompt(prompt) {
  const text = String(prompt || "");
  return SMART_COMPACT_PREFIX.test(text) || text.includes(SMART_COMPACT_TAG) || text.includes(SMART_COMPACT_MARKER);
}
