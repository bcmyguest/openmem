const TIMEOUT_MS = 8000;

/**
 * @param {string} url
 * @returns {Promise<object|null>}
 */
export async function fetchJson(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** @param {object|null} body OpenAI /v1/models or similar */
export function openAiModelIds(body) {
  if (!body || !Array.isArray(body.data)) return [];
  return body.data.map((m) => m.id).filter(Boolean);
}

/** @param {object|null} body Ollama /api/tags */
export function ollamaModelNames(body) {
  if (!body || !Array.isArray(body.models)) return [];
  return body.models.map((m) => m.name).filter(Boolean);
}

export function normalizeOpenAiBase(base) {
  let b = base.trim().replace(/\/+$/, "");
  if (!b.endsWith("/v1")) b += "/v1";
  return b;
}

/**
 * GET `url` and report the HTTP status (0 when nothing answered) and the parsed JSON body.
 * @param {string} url
 * @param {{ headers?: Record<string, string>, timeoutMs?: number }} [opts]
 * @returns {Promise<{ status: number, json: any }>}
 */
export async function fetchStatus(url, { headers = {}, timeoutMs = TIMEOUT_MS } = {}) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  } catch {
    return { status: 0, json: null };
  }
}
