/** PMM (Personal Memory Manifest) export/import — orchestrator over provider adapters. */

import { runProviderExport } from "./export/index.mjs";

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
 * @param {ReturnType<typeof buildPmm>} pmm
 * @param {string} format
 */
export function serializePmm(pmm, format) {
  if (format === "jsonl") {
    const header = { ...pmm, records: undefined };
    const lines = [JSON.stringify(header), ...(pmm.records || []).map((r) => JSON.stringify(r))];
    return `${lines.join("\n")}\n`;
  }
  return pmm;
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
  const format = String(args.format || "json").toLowerCase();
  const { scope, records, note } = await runProviderExport(ctx.provider, ctx, args, fetchFn);
  const pmm = buildPmm({ provider: ctx.provider, scope, records });
  if (note) pmm.note = note;
  return serializePmm(pmm, format);
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
