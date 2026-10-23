/** PMM (Personal Memory Manifest) export/import — orchestrator over provider adapters. */

import { runProviderExport } from "./export/index.mjs";
import { exportMem0 } from "./export/mem0.mjs";
import { importMetadata, isPlainObject } from "./pmm-metadata.mjs";
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
 * Parse a PMM export: one JSON document, or JSONL (a header line, then one record per line).
 * A document that is not valid JSON as a whole is read as JSONL, so a JSONL export (which also
 * starts with "{") is never mistaken for a single document.
 * @param {string} data
 * @returns {{ pmm: ReturnType<typeof buildPmm> }}
 */
export function parsePmm(data) {
  const trimmed = String(data || "").trim();
  if (!trimmed) throw new Error("import data is empty");
  let whole;
  try {
    whole = JSON.parse(trimmed);
  } catch (err) {
    if (!trimmed.includes("\n")) throw new Error(`import data is not valid JSON: ${err instanceof Error ? err.message : err}`);
    return parsePmmJsonl(trimmed);
  }
  if (!isPlainObject(whole)) throw new Error("import data must be a PMM JSON object");
  assertPmmVersion(whole.pmm_version);
  if (whole.records != null && !Array.isArray(whole.records)) throw new Error("PMM records must be an array");
  return { pmm: { ...whole, records: sortPmmRecords(whole.records || []) } };
}

/** @param {string} trimmed */
function parsePmmJsonl(trimmed) {
  /** @type {object[]} */
  const records = [];
  let meta = null;
  const lines = trimmed.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const row = lines[i].trim();
    if (!row) continue;
    let obj;
    try {
      obj = JSON.parse(row);
    } catch (err) {
      throw new Error(`jsonl line ${i + 1}: ${err instanceof Error ? err.message : err}`);
    }
    if (!isPlainObject(obj)) throw new Error(`jsonl line ${i + 1}: expected a JSON object`);
    if ("pmm_version" in obj) {
      if (meta) throw new Error(`jsonl line ${i + 1}: second PMM header`);
      if (records.length) throw new Error(`jsonl line ${i + 1}: PMM header must be the first line`);
      assertPmmVersion(obj.pmm_version);
      meta = obj;
      if (Array.isArray(obj.records)) records.push(...obj.records);
    } else {
      if (!meta) throw new Error("jsonl import requires a PMM header line first");
      records.push(obj);
    }
  }
  if (!meta) throw new Error("jsonl import requires a PMM header line first");
  return { pmm: { ...meta, records: sortPmmRecords(records) } };
}

/** @param {unknown} result an MCP tool result */
function resultPayload(result) {
  const text = /** @type {any} */ (result)?.content?.[0]?.text;
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
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
  /** @type {{ id: string, error: string }[]} */
  const failed = [];
  /** @type {Record<string, { stringified: number, dropped: number }>} */
  const lossy = {};
  /** @type {{ ids: Set<string>, fingerprints: Set<string> } | null} */
  let mem0Seen = null;
  for (const rec of pmm.records || []) {
    const content = String(rec.content || "").trim();
    if (!content) continue;
    const label = rec.id ? String(rec.id) : content.slice(0, 40);
    const bank = String(rec.scope_key || pmm.scope?.bank || pmm.scope?.user_id || "personal-memory-mcp");
    const fp = pmmContentFingerprint(content);
    if (strategy === "skip_duplicates" && ctx.provider === "mem0") {
      if (!mem0Seen) mem0Seen = await mem0ExistingKeys(ctx, bank, fetchFn);
      if ((rec.id && mem0Seen.ids.has(String(rec.id))) || mem0Seen.fingerprints.has(fp)) {
        skipped.push(rec.id ? String(rec.id) : fp.slice(0, 40));
        continue;
      }
    }
    const metadata = importMetadata(rec, pmm.source_provider);
    let result;
    try {
      result = await addFn(ctx, "memory_add", { content, bank, metadata }, fetchFn);
    } catch (err) {
      failed.push({ id: label, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const payload = resultPayload(result);
    if (result?.isError) {
      failed.push({ id: label, error: typeof payload === "string" ? payload : JSON.stringify(payload) });
      continue;
    }
    if (mem0Seen) {
      mem0Seen.fingerprints.add(fp);
      if (rec.id) mem0Seen.ids.add(String(rec.id));
    }
    imported.push(label);
    const report = isPlainObject(payload) ? payload.metadata_lossy : null;
    for (const kind of /** @type {const} */ (["stringified", "dropped"])) {
      for (const key of Array.isArray(report?.[kind]) ? report[kind] : []) {
        lossy[key] ??= { stringified: 0, dropped: 0 };
        lossy[key][kind]++;
      }
    }
  }
  const status = !failed.length ? "complete" : imported.length ? "partial" : "failed";
  return {
    pmm_version: PMM_VERSION,
    target_provider: ctx.provider,
    source_provider: pmm.source_provider,
    merge_strategy: strategy,
    status,
    imported_count: imported.length,
    skipped_count: skipped.length,
    failed_count: failed.length,
    failed,
    metadata_lossy: lossy,
    provenance: "source ids are stored as metadata pmm_source_id (and pmm_source_provider)",
    cross_provider: pmm.source_provider !== ctx.provider,
  };
}
