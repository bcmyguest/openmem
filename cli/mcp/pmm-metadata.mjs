/**
 * Metadata carried through PMM import and `memory_add`, and how each provider stores it.
 *
 * Provenance: an imported record keeps its source id and provider as metadata keys
 * `pmm_source_id` and `pmm_source_provider`, because destination ids are assigned anew.
 *
 * Every provider write reports what it could not store verbatim as `metadata_lossy`:
 *   { stringified: [keys whose values were JSON-encoded], dropped: [keys not stored] }
 */

export const PMM_SOURCE_ID = "pmm_source_id";
export const PMM_SOURCE_PROVIDER = "pmm_source_provider";

/** @param {unknown} v */
export function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Metadata to write for an imported PMM record: its own metadata plus provenance.
 * @param {{ id?: unknown, metadata?: unknown }} rec
 * @param {string | undefined} sourceProvider
 */
export function importMetadata(rec, sourceProvider) {
  const meta = isPlainObject(rec.metadata) ? { ...rec.metadata } : {};
  if (rec.id != null && rec.id !== "") meta[PMM_SOURCE_ID] = String(rec.id);
  if (sourceProvider) meta[PMM_SOURCE_PROVIDER] = String(sourceProvider);
  return meta;
}

/** @param {unknown} v */
function validTimestamp(v) {
  return typeof v === "string" && v.trim() !== "" && !Number.isNaN(Date.parse(v)) ? v : null;
}

/**
 * A Hindsight retain item. Hindsight metadata is a string→string map, so non-string values are
 * JSON-encoded and nulls dropped. Known keys also fill Hindsight's own fields (timestamp,
 * context, document_id, tags) and stay in metadata so a later export sees them unchanged.
 * @param {string} content
 * @param {Record<string, unknown>} metadata
 */
export function hindsightItem(content, metadata) {
  /** @type {Record<string, unknown>} */
  const item = { content };
  /** @type {Record<string, string>} */
  const stored = {};
  const stringified = [];
  const dropped = [];
  for (const [k, v] of Object.entries(metadata)) {
    if (v == null) {
      dropped.push(k);
    } else if (typeof v === "string") {
      stored[k] = v;
    } else {
      stored[k] = JSON.stringify(v);
      stringified.push(k);
    }
  }
  const ts = validTimestamp(metadata.timestamp) ?? validTimestamp(metadata.occurred_start) ?? validTimestamp(metadata.date);
  if (ts) item.timestamp = ts;
  if (typeof metadata.context === "string" && metadata.context) item.context = metadata.context;
  if (typeof metadata.document_id === "string" && metadata.document_id) item.document_id = metadata.document_id;
  if (Array.isArray(metadata.tags) && metadata.tags.every((t) => typeof t === "string")) item.tags = metadata.tags;
  if (Object.keys(stored).length) item.metadata = stored;
  return { item, lossy: { stringified, dropped } };
}

/** mem0 stores arbitrary JSON metadata as given. */
export function mem0Lossy() {
  return { stringified: [], dropped: [] };
}

/**
 * Cognee's JSON add endpoint takes only text and a dataset name: every metadata key is dropped.
 * @param {Record<string, unknown>} metadata
 */
export function cogneeLossy(metadata) {
  return { stringified: [], dropped: Object.keys(metadata) };
}
