/** OpenCode 2 message helpers for binding prompt recall to the user message that prompted it. */
import crypto from "node:crypto";

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

/** A user message with content that is not only tool results. */
export function isTurnStart(message) {
  if (message?.role !== "user" || !Array.isArray(message.content)) return false;
  return message.content.length > 0 && !message.content.some((p) => p?.type === "tool-result");
}

function whereOf(error) {
  const frame = String(error?.stack || "").split("\n").find((line) => /^\s+at /.test(line)) || "";
  return /([^/\\(\s]+:\d+)(?::\d+)?\)?\s*$/.exec(frame)?.[1] || "?";
}

/** One stderr line: exception type and location only, never message content. */
export function logFailOpen(error) {
  process.stderr.write(`openmem: fail-open ${error?.name || typeof error} at ${whereOf(error)}\n`);
}
