/** PMM (Personal Memory Manifest) export/import — orchestrator over provider adapters. */

import { runProviderExport } from "./export/index.mjs";
import { exportMem0 } from "./export/mem0.mjs";
import { pmmContentFingerprint, sortPmmRecords } from "./pmm-records.mjs";

export const PMM_VERSION = 1;
export const PMM_SUPPORTED_MAJOR = 1;

/**
 * @param {unknown} version
 */
export function assertPmmVersion(version) {
  const n = Number(version);
  if (!Number.isFinite(n) || Math.floor(n) !== n) {
    throw new Error(`unsupported pmm_version ${String(version)}`);
  }
  const major = n;
  if (major !== PMM_SUPPORTED_MAJOR) {
    throw new Error(`unsupported PMM major version ${major} (supported: ${PMM_SUPPORTED_MAJOR})`);
  }
}

/**
 * @param {{ provider: string, scope: Record<string, unknown>, records: object[] }} parts
 */
export function buildPmm(parts) {
  return {
    pmm_version: PMM_VERSION,
    exported_at: new Date().toISOString(),
    source_provider: parts.provider,
    scope: parts.scope,
    records: sortPmmRecords(parts.records || []),
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
  let document = null;
  try { document = JSON.parse(trimmed); } catch { /* JSONL contains multiple JSON objects. */ }
  if (document && typeof document === "object" && !Array.isArray(document)) {
    const pmm = document;
    assertPmmVersion(pmm.pmm_version);
    return { pmm: { ...pmm, records: sortPmmRecords(pmm.records || []) } };
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
  assertPmmVersion(meta.pmm_version);
  return { pmm: { ...meta, records: sortPmmRecords(records) } };
}

/**
 * @param {ReturnType<typeof buildPmm>} pmm
 * @param {import("./context.mjs").resolveMcpContext extends (...a: any) => infer R ? R : never} ctx
 * @param {typeof fetch} fetchFn
 */
async function mem0ExistingKeys(ctx, userId, fetchFn) {
  const { records } = await exportMem0(ctx, { user_id: userId }, fetchFn);
  const ids = new Set();
  const fingerprints = new Set();
  for (const r of records) {
    if (r.id) ids.add(String(r.id));
    fingerprints.add(pmmContentFingerprint(String(r.content || "")));
  }
  return { ids, fingerprints };
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
  /** @type {Map<string, { ids: Set<string>, fingerprints: Set<string> }>} */
  const mem0Seen = new Map();
  for (const rec of pmm.records || []) {
    const content = String(rec.content || "").trim();
    if (!content) continue;
    const bank = String(rec.scope_key || pmm.scope?.bank || pmm.scope?.user_id || "personal-memory-mcp");
    if (strategy === "skip_duplicates" && ctx.provider === "mem0") {
      if (!mem0Seen.has(bank)) mem0Seen.set(bank, await mem0ExistingKeys(ctx, bank, fetchFn));
      const seen = mem0Seen.get(bank);
      const fp = pmmContentFingerprint(content);
      if ((rec.id && seen.ids.has(String(rec.id))) || seen.fingerprints.has(fp)) {
        skipped.push(rec.id ? String(rec.id) : fp.slice(0, 40));
        continue;
      }
      seen.fingerprints.add(fp);
      if (rec.id) seen.ids.add(String(rec.id));
    }
    const result = await addFn(ctx, "memory_add", { content, bank }, fetchFn);
    if (result?.isError) {
      throw new Error(`memory import failed in bank ${bank}: ${result.content?.[0]?.text || "memory_add returned an error"}`);
    }
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
