/** PMM record ordering and duplicate fingerprints (export/import). */

/**
 * Stable sort for deterministic exports and diffs.
 * @param {object[]} records
 */
export function sortPmmRecords(records) {
  return [...records].sort((a, b) => {
    const sa = String(a.scope_key ?? "");
    const sb = String(b.scope_key ?? "");
    if (sa !== sb) return sa.localeCompare(sb);
    const ia = String(a.id ?? "");
    const ib = String(b.id ?? "");
    if (ia !== ib) return ia.localeCompare(ib);
    return String(a.content ?? "").localeCompare(String(b.content ?? ""));
  });
}

/** @param {string} content */
export function pmmContentFingerprint(content) {
  const t = String(content || "").trim().replace(/\s+/g, " ");
  return t;
}
