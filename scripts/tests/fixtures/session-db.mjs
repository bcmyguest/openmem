/**
 * Test helper: write rows into a session database (sessions/<sid>.db) the way the proxy does, through the
 * shared chain + SessionDB.sync. Rows are stored in the given order, so seq runs 1, 2, … per call.
 */
import path from "node:path";
import { chain, dropSession, openSession } from "../../../cli/coding-agent/session-db.mjs";

/**
 * @param {string} sessionsDir
 * @param {string} sid
 * @param {{ role?: string, kind?: string, name?: string | null, text: string, blob_id?: string | null, in_context?: boolean }[]} rows
 * @param {string} [ts]
 */
export function writeSessionRows(sessionsDir, sid, rows, ts = "2026-10-29T17:00:00Z") {
  const file = path.join(sessionsDir, `${sid}.db`);
  const stored = chain(rows.map((r) => ({
    role: r.role ?? "user", kind: r.kind ?? "text", name: r.name ?? null, text: r.text, blob_id: r.blob_id ?? null,
    keep: r.in_context !== false,
  })));
  openSession(file).sync(stored, null, ts);
  dropSession(file);
  return file;
}
