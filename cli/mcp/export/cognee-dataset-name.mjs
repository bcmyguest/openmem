import crypto from "node:crypto";

const SLUG_MAX = 40;

/** Match `indexer/sinks/cognee.py` `dataset_name(bank)`. */
export function cogneeDatasetName(bank) {
  const raw = String(bank ?? "");
  let slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  slug = slug.slice(0, SLUG_MAX).replace(/^_+|_+$/g, "") || "bank";
  const hash = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 8);
  return `${slug}_${hash}`;
}
