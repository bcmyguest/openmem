import { authHeaders } from "../../cognee-mcp.mjs";
import { cogneeDatasetName } from "./cognee-dataset-name.mjs";

const PAGE = 1000;

/**
 * @param {{ cognee?: { baseUrl: string, apiKey?: string } }} ctx
 * @param {{ bank?: string }} args
 * @param {typeof fetch} fetchFn
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function exportCognee(ctx, args, fetchFn, env = process.env) {
  const base = ctx.cognee?.baseUrl?.replace(/\/+$/, "");
  if (!base) throw new Error("Cognee API URL not configured");
  const headers = { ...authHeaders(env) };
  const bank = String(args.bank || "personal-memory-mcp").trim() || "personal-memory-mcp";
  const datasetName = cogneeDatasetName(bank);

  const listRes = await fetchFn(`${base}/api/v1/datasets`, { headers });
  const listText = await listRes.text();
  if (!listRes.ok) throw new Error(`GET /api/v1/datasets → ${listRes.status}: ${listText.slice(0, 400)}`);
  let datasets;
  try {
    datasets = listText ? JSON.parse(listText) : [];
  } catch {
    throw new Error("GET /api/v1/datasets: invalid JSON");
  }
  const row = (Array.isArray(datasets) ? datasets : []).find(
    (d) => d && typeof d === "object" && d.name === datasetName && d.id,
  );
  if (!row) {
    return {
      scope: { bank, dataset: datasetName },
      records: [],
      note: `No Cognee dataset named ${datasetName}; indexer may not have written to this bank yet.`,
    };
  }
  const datasetId = String(row.id);
  /** @type {object[]} */
  const records = [];
  let offset = 0;
  while (true) {
    const url = `${base}/api/v1/datasets/${encodeURIComponent(datasetId)}/data?limit=${PAGE}&offset=${offset}`;
    const res = await fetchFn(url, { headers });
    const text = await res.text();
    if (!res.ok) throw new Error(`GET dataset data → ${res.status}: ${text.slice(0, 400)}`);
    let page;
    try {
      page = text ? JSON.parse(text) : [];
    } catch {
      throw new Error("GET dataset data: invalid JSON");
    }
    if (!Array.isArray(page)) break;
    for (const item of page) {
      if (!item || typeof item !== "object") continue;
      const label = item.label ?? item.name ?? "";
      const meta = item.externalMetadata ?? item.external_metadata ?? {};
      records.push({
        id: item.id != null ? String(item.id) : null,
        content: String(label || item.name || "").trim() || `[cognee:${item.name || item.id}]`,
        metadata: { cognee: { name: item.name ?? null, externalMetadata: meta } },
        scope_key: bank,
      });
    }
    if (page.length < PAGE) break;
    offset += page.length;
  }
  return { scope: { bank, dataset: datasetName, dataset_id: datasetId }, records };
}
