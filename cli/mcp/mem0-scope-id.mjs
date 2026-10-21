/** Same mapping as indexer/sinks/mem0.py scope_id (user_id / run_id). */
import crypto from "node:crypto";

export function mem0ScopeId(value) {
  const s = String(value ?? "");
  if (!/\s/.test(s)) return s;
  let out = "";
  let inSpace = false;
  for (const ch of s) {
    if (ch.trim() === "") {
      if (!inSpace) {
        out += "_";
        inSpace = true;
      }
    } else {
      out += ch;
      inSpace = false;
    }
  }
  const digest = crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 8);
  return `${out}~${digest}`;
}
