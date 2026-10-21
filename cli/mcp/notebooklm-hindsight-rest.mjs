/** Hindsight REST helpers for notebooklm::* banks (shared by MCP server and provider adapter). */

export async function listBanks(apiUrl, fetchFn = fetch) {
  const res = await fetchFn(`${apiUrl}/v1/default/banks`);
  if (!res.ok) throw new Error(`GET /v1/default/banks → ${res.status} ${res.statusText}`);
  const data = await res.json();
  return Array.isArray(data?.banks) ? data.banks : Array.isArray(data) ? data : [];
}

export async function listMemories(apiUrl, bankId, query, opts = {}, fetchFn = fetch) {
  const limit = Number.isFinite(opts.limit) ? Math.max(0, Math.floor(opts.limit)) : 20;
  const offset = Number.isFinite(opts.offset) ? Math.max(0, Math.floor(opts.offset)) : 0;
  const qs = new URLSearchParams({ q: query, limit: String(limit), offset: String(offset) });
  const url = `${apiUrl}/v1/default/banks/${encodeURIComponent(bankId)}/memories/list?${qs}`;
  const res = await fetchFn(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`GET memories/list ${bankId} → ${res.status}: ${text.slice(0, 400)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function recallBank(apiUrl, bankId, query, fetchFn = fetch, opts = {}) {
  const url = `${apiUrl}/v1/default/banks/${encodeURIComponent(bankId)}/memories/recall`;
  const body = {
    query,
    budget: opts.budget || "low",
    max_tokens: opts.max_tokens ?? 1024,
    include: { entities: null, chunks: null, source_facts: null },
  };
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST recall ${bankId} → ${res.status}: ${text.slice(0, 400)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
