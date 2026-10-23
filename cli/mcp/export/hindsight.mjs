import { listBanks, listMemories } from "../../notebooklm-mcp.mjs";

const PAGE = 500;

/** Hindsight memory fields kept in PMM metadata: source, timestamps and supersession state. */
const KEPT_FIELDS = [
  "fact_type", "context", "document_id", "tags", "date", "mentioned_at", "occurred_start", "occurred_end",
  "updated_at", "state", "invalidation_reason", "invalidated_at", "source_memory_ids",
];

/**
 * The item's own metadata plus each non-empty kept field.
 * @param {Record<string, any>} m a /memories/list item
 */
export function hindsightRecordMetadata(m) {
  /** @type {Record<string, unknown>} */
  const out = m.metadata && typeof m.metadata === "object" ? { ...m.metadata } : {};
  const type = m.fact_type ?? m.type;
  if (type != null) out.type = type;
  for (const k of KEPT_FIELDS) {
    const v = m[k];
    if (v == null || v === "" || (Array.isArray(v) && !v.length)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * @param {{ hindsightUrl?: string }} ctx
 * @param {{ bank?: string }} args
 * @param {typeof fetch} fetchFn
 */
export async function exportHindsight(ctx, args, fetchFn) {
  const base = ctx.hindsightUrl;
  if (!base) throw new Error("Hindsight API URL not configured");
  const bankFilter = String(args.bank || "").trim();
  const bankRows = await listBanks(base, fetchFn);
  const bankIds = bankRows
    .map((b) => b.bank_id || b.id || b.name || "")
    .filter(Boolean);
  const banks = bankFilter ? bankIds.filter((id) => id === bankFilter) : bankIds;
  if (bankFilter && !banks.length) {
    throw new Error(`bank not found: ${bankFilter}`);
  }
  /** @type {object[]} */
  const records = [];
  for (const bank of banks) {
    let offset = 0;
    while (true) {
      const page = await listMemories(base, bank, "", { limit: PAGE, offset }, fetchFn);
      const items = Array.isArray(page?.items) ? page.items : [];
      for (const m of items) {
        const content = String(m.text ?? m.content ?? "").trim();
        if (!content) continue;
        records.push({
          id: m.id ?? m.memory_id ?? null,
          content,
          metadata: hindsightRecordMetadata(m),
          scope_key: bank,
        });
      }
      const total = Number.isFinite(page?.total) ? page.total : items.length;
      offset += items.length;
      if (!items.length || items.length < PAGE || offset >= total) break;
    }
  }
  return {
    scope: bankFilter ? { bank: bankFilter } : { all_banks: true, bank_count: banks.length },
    records,
  };
}
