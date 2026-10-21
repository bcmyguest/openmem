/** PMM (Personal Memory Manifest) export/import — provider adapters. */

export const PMM_VERSION = 1;

/**
 * @param {{ provider: string, scope: Record<string, unknown>, records: object[] }} parts
 */
export function buildPmm(parts) {
  return {
    pmm_version: PMM_VERSION,
    exported_at: new Date().toISOString(),
    source_provider: parts.provider,
    scope: parts.scope,
    records: parts.records,
  };
}

/**
 * @param {string} data
 * @returns {{ pmm: ReturnType<typeof buildPmm> }}
 */
export function parsePmm(data) {
  const trimmed = String(data || "").trim();
  if (!trimmed) throw new Error("import data is empty");
  if (trimmed.startsWith("{")) {
    const pmm = JSON.parse(trimmed);
    if (pmm.pmm_version !== PMM_VERSION) throw new Error(`unsupported pmm_version ${pmm.pmm_version}`);
    return { pmm };
  }
  /** @type {ReturnType<typeof buildPmm>["records"]} */
  const records = [];
  let meta = null;
  for (const line of trimmed.split("\n")) {
    const row = line.trim();
    if (!row) continue;
    const obj = JSON.parse(row);
    if (obj.pmm_version === PMM_VERSION && obj.source_provider) {
      meta = obj;
      if (Array.isArray(obj.records)) records.push(...obj.records);
    } else if (obj.content != null) {
      records.push(obj);
    }
  }
  if (!meta) throw new Error("jsonl import requires a PMM header line or a single JSON object");
  return { pmm: { ...meta, records } };
}

/**
 * @param {import("./context.mjs").resolveMcpContext extends (...a: any) => infer R ? R : never} ctx
 * @param {{ bank?: string, format?: string }} args
 * @param {typeof fetch} fetchFn
 */
export async function memoryExport(ctx, args, fetchFn = fetch) {
  const scopeBank = String(args.bank || "personal-memory-mcp").trim() || "personal-memory-mcp";
  const format = String(args.format || "json").toLowerCase();
  if (ctx.provider === "mem0") {
    return exportMem0(ctx, { user_id: scopeBank }, format, fetchFn);
  }
  if (ctx.provider === "hindsight") {
    const pmm = buildPmm({
      provider: "hindsight",
      scope: { bank: scopeBank },
      records: [],
    });
    pmm.note =
      "Hindsight has no list-memories API in PMM v1; use recall per bank or export from the Hindsight API directly.";
    return format === "jsonl" ? `${JSON.stringify(pmm)}\n` : pmm;
  }
  if (ctx.provider === "cognee") {
    const pmm = buildPmm({
      provider: "cognee",
      scope: { dataset: scopeBank },
      records: [],
    });
    pmm.note = "Cognee bulk export is not implemented in PMM v1; use Cognee REST or dataset tools.";
    return format === "jsonl" ? `${JSON.stringify(pmm)}\n` : pmm;
  }
  throw new Error(`export not supported for provider ${ctx.provider}`);
}

async function exportMem0(ctx, scope, format, fetchFn) {
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
  const pmm = buildPmm({ provider: "mem0", scope, records });
  if (format === "jsonl") {
    return `${JSON.stringify({ ...pmm, records: undefined })}\n${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
  }
  return pmm;
}

/**
 * @param {import("./context.mjs").resolveMcpContext extends (...a: any) => infer R ? R : never} ctx
 * @param {string} data
 * @param {{ merge_strategy?: string }} args
 * @param {typeof fetch} fetchFn
 * @param {(ctx: any, name: string, toolArgs: object, fetchFn: typeof fetch) => Promise<any>} addFn
 */
export async function memoryImport(ctx, data, args, fetchFn, addFn) {
  const { pmm } = parsePmm(data);
  const strategy = String(args.merge_strategy || "skip_duplicates");
  /** @type {string[]} */
  const imported = [];
  /** @type {string[]} */
  const skipped = [];
  for (const rec of pmm.records || []) {
    const content = String(rec.content || "").trim();
    if (!content) continue;
    const bank = String(rec.scope_key || pmm.scope?.bank || pmm.scope?.user_id || "personal-memory-mcp");
    if (strategy === "skip_duplicates" && rec.id && ctx.provider === "mem0") {
      skipped.push(String(rec.id));
      continue;
    }
    await addFn(ctx, "memory_add", { content, bank }, fetchFn);
    imported.push(rec.id ? String(rec.id) : content.slice(0, 40));
  }
  return {
    pmm_version: PMM_VERSION,
    target_provider: ctx.provider,
    source_provider: pmm.source_provider,
    merge_strategy: strategy,
    imported_count: imported.length,
    skipped_count: skipped.length,
    cross_provider: pmm.source_provider !== ctx.provider,
  };
}
