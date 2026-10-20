/**
 * Small fetch wrapper for the mem0 REST server. Every call goes to a path under the
 * resolved mem0 URL; redirects are never followed (a custom header such as X-API-Key is
 * not stripped on a cross-origin redirect), and errors never carry the key.
 */

/**
 * @param {string} text
 * @param {string} secret
 */
export function redact(text, secret) {
  let out = String(text ?? "");
  if (secret) out = out.split(secret).join("***");
  return out;
}

/**
 * Text from the server made safe to print: control characters (terminal escapes, newlines)
 * become spaces and the length is capped.
 * @param {unknown} text
 * @param {number} [max]
 */
export function clean(text, max = 200) {
  return String(text ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Short, key-free description of a fetch failure. @param {unknown} e */
export function describeError(e) {
  const err = /** @type {{ name?: string, message?: string, cause?: { code?: string } }} */ (e);
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return "timed out";
  return err?.cause?.code || err?.message || "request failed";
}

/**
 * @param {string} base resolved, validated mem0 URL (no trailing slash)
 * @param {string} method
 * @param {string} route path (and query) under the base, starting with '/'
 * @param {{ key?: string, body?: unknown, timeoutMs?: number }} [opts]
 * @returns {Promise<{ status: number, ok: boolean, text: string, json: any }>}
 */
export async function request(base, method, route, opts = {}) {
  /** @type {Record<string, string>} */
  const headers = { Accept: "application/json" };
  if (opts.key) headers["X-API-Key"] = opts.key;
  /** @type {RequestInit} */
  const init = {
    method,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
  };
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(`${base}${route}`, init);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, ok: res.status >= 200 && res.status < 300, text, json };
}
