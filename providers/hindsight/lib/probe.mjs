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
