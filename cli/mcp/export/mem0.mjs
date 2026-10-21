/**
 * @param {{ mem0?: { baseUrl: string, apiKey?: string } }} ctx
 * @param {{ user_id: string }} scope
 * @param {typeof fetch} fetchFn
 */
export async function exportMem0(ctx, scope, fetchFn) {
  const base = ctx.mem0?.baseUrl;
  const key = ctx.mem0?.apiKey;
  if (!base) throw new Error("mem0 API URL not configured");
  /** @type {Record<string, string>} */
  const headers = {};
  if (key) headers["X-API-Key"] = key;
  const q = new URLSearchParams({ user_id: scope.user_id, top_k: "1000" });
  const res = await fetchFn(`${base}/memories?${q}`, { headers });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`GET /memories → ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`GET /memories → ${res.status}: ${text.slice(0, 400)}`);
  const raw = Array.isArray(json) ? json : json.results || json.memories || [];
  const records = raw.map((row) => ({
    id: row.id ?? row.memory_id ?? null,
    content: row.memory ?? row.text ?? row.content ?? JSON.stringify(row),
    metadata: row.metadata ?? {},
    scope_key: scope.user_id,
  }));
  return { scope, records };
}
