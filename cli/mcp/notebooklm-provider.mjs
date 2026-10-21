import fs from "node:fs";
import { cogneeDatasetName } from "./export/cognee-dataset-name.mjs";
import { mem0ScopeId } from "./mem0-scope-id.mjs";
import { bankAllowed, filterNotebooklmBanks, isNotebooklmBank } from "./notebooklm-banks.mjs";
import { listBanks, listMemories, recallBank } from "./notebooklm-hindsight-rest.mjs";
import { search as cogneeSearch } from "../cognee-mcp.mjs";

function readStateBanks(statePath) {
  if (!statePath || !fs.existsSync(statePath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const docs = data?.documents && typeof data.documents === "object" ? data.documents : {};
    const banks = new Set();
    for (const row of Object.values(docs)) {
      if (row?.bank && isNotebooklmBank(String(row.bank))) banks.add(String(row.bank));
    }
    return [...banks];
  } catch {
    return [];
  }
}

function mem0Headers(ctx) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (ctx.mem0?.apiKey) headers["X-API-Key"] = ctx.mem0.apiKey;
  return headers;
}

async function mem0Get(base, path, headers, fetchFn) {
  const res = await fetchFn(`${base.replace(/\/$/, "")}${path}`, { headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function mem0MemoryText(row) {
  return row?.memory ?? row?.text ?? row?.content ?? row?.data ?? "";
}

/** @param {import("./context.mjs").McpContext} ctx @param {string[]} allowlist @param {typeof fetch} fetchFn */
export async function listNotebooklmBanks(ctx, allowlist, fetchFn = fetch) {
  if (ctx.provider === "hindsight") {
    const url = ctx.hindsightUrl || "http://127.0.0.1:8888";
    return filterNotebooklmBanks(await listBanks(url, fetchFn), allowlist).map((b) => ({
      bank_id: b.bank_id || b.id || b.name,
      fact_count: b.fact_count ?? null,
      name: b.name ?? null,
    }));
  }
  if (ctx.provider === "mem0") {
    const base = ctx.mem0?.baseUrl;
    if (!base) throw new Error("mem0 API URL not configured");
    const headers = mem0Headers(ctx);
    const statePath = process.env.NOTEBOOKLM_STATE || "";
    const candidates = new Set();
    if (allowlist.includes("*")) {
      for (const b of readStateBanks(statePath)) candidates.add(b);
      if (!candidates.size && !statePath) {
        throw new Error(
          "mem0: set NOTEBOOKLM_STATE to the sync state.json path, or list explicit notebooklmAccess.banks",
        );
      }
    }
    for (const entry of allowlist) {
      if (entry === "*") continue;
      candidates.add(entry.startsWith("notebooklm::") ? entry : `notebooklm::${entry}`);
    }
    const out = [];
    for (const bankId of candidates) {
      if (!bankAllowed(bankId, allowlist)) continue;
      const uid = encodeURIComponent(mem0ScopeId(bankId));
      const json = await mem0Get(base, `/memories?user_id=${uid}&top_k=1000`, headers, fetchFn);
      const results = Array.isArray(json?.results) ? json.results : [];
      if (results.length || !allowlist.includes("*")) {
        out.push({ bank_id: bankId, fact_count: results.length, name: null });
      }
    }
    return out;
  }
  if (ctx.provider === "cognee") {
    const base = ctx.cognee?.baseUrl;
    if (!base) throw new Error("Cognee API URL not configured");
    const headers = { ...(ctx.cognee?.apiKey ? { "X-Api-Key": ctx.cognee.apiKey } : {}) };
    const res = await fetchFn(`${base.replace(/\/$/, "")}/api/v1/datasets`, { headers });
    const text = await res.text();
    if (!res.ok) throw new Error(`GET datasets → ${res.status}: ${text.slice(0, 300)}`);
    const datasets = JSON.parse(text);
    const list = Array.isArray(datasets) ? datasets : datasets?.datasets || [];
    const byBank = new Map();
    for (const ds of list) {
      const id = ds.id ?? ds.dataset_id;
      if (!id) continue;
      const dataRes = await fetchFn(`${base.replace(/\/$/, "")}/api/v1/datasets/${id}/data?limit=5`, { headers });
      if (!dataRes.ok) continue;
      const page = await dataRes.json();
      const rows = Array.isArray(page) ? page : page?.data || [];
      for (const row of rows) {
        const meta = row?.external_metadata ?? row?.externalMetadata;
        let bank = null;
        if (Array.isArray(meta)) {
          for (const m of meta) if (m?.bank) bank = m.bank;
        } else if (meta && typeof meta === "object" && meta.bank) bank = meta.bank;
        else if (typeof meta === "string") {
          try {
            const parsed = JSON.parse(meta);
            if (parsed?.bank) bank = parsed.bank;
          } catch {
            /* ignore */
          }
        }
        if (bank && isNotebooklmBank(bank) && bankAllowed(bank, allowlist)) {
          byBank.set(bank, { bank_id: bank, fact_count: null, name: ds.name ?? null });
        }
      }
    }
    return [...byBank.values()];
  }
  throw new Error(`notebooklm MCP does not support provider ${ctx.provider}`);
}

/** @param {import("./context.mjs").McpContext} ctx @param {{ bankId: string, query: string, mode: string, limit: number, hindsightApiUrl?: string }} opts @param {typeof fetch} fetchFn */
export async function searchNotebooklmBank(ctx, opts, fetchFn = fetch) {
  const { bankId, query, mode, limit, hindsightApiUrl } = opts;
  if (ctx.provider === "hindsight") {
    const apiUrl = ctx.hindsightUrl || hindsightApiUrl || "http://127.0.0.1:8888";
    if (mode === "recall") {
      return { bank_id: bankId, query, mode, result: await recallBank(apiUrl, bankId, query, fetchFn) };
    }
    const listed = await listMemories(apiUrl, bankId, query, { limit }, fetchFn);
    const items = Array.isArray(listed?.items)
      ? listed.items.map((m) => ({
          id: m.id ?? m.memory_id ?? null,
          type: m.type ?? null,
          text: m.text ?? m.content ?? null,
        }))
      : listed;
    return {
      bank_id: bankId,
      query,
      mode: "list",
      total: listed?.total ?? null,
      limit: listed?.limit ?? limit,
      offset: listed?.offset ?? 0,
      items,
    };
  }
  if (ctx.provider === "mem0") {
    const base = ctx.mem0?.baseUrl;
    if (!base) throw new Error("mem0 API URL not configured");
    const headers = { "content-type": "application/json", ...mem0Headers(ctx) };
    const uid = mem0ScopeId(bankId);
    if (mode === "recall") {
      const res = await fetchFn(`${base.replace(/\/$/, "")}/search`, {
        method: "POST",
        headers,
        body: JSON.stringify({ query, filters: { user_id: uid }, top_k: limit }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`POST /search → ${res.status}: ${text.slice(0, 300)}`);
      return { bank_id: bankId, query, mode: "recall", result: JSON.parse(text) };
    }
    const json = await mem0Get(
      base,
      `/memories?user_id=${encodeURIComponent(uid)}&top_k=${Math.min(limit, 1000)}`,
      mem0Headers(ctx),
      fetchFn,
    );
    const q = query.toLowerCase();
    const results = (Array.isArray(json?.results) ? json.results : []).filter((r) =>
      mem0MemoryText(r).toLowerCase().includes(q),
    );
    return {
      bank_id: bankId,
      query,
      mode: "list",
      items: results.slice(0, limit).map((r) => ({
        id: r.id ?? null,
        type: null,
        text: mem0MemoryText(r),
      })),
    };
  }
  if (ctx.provider === "cognee") {
    const dataset = cogneeDatasetName(bankId);
    if (mode === "recall") {
      const result = await cogneeSearch(
        { baseUrl: ctx.cognee.baseUrl, apiKey: ctx.cognee?.apiKey },
        { query, datasets: [dataset] },
        fetchFn,
      );
      return { bank_id: bankId, query, mode: "recall", result };
    }
    const base = ctx.cognee.baseUrl.replace(/\/$/, "");
    const headers = { ...(ctx.cognee?.apiKey ? { "X-Api-Key": ctx.cognee.apiKey } : {}) };
    const dsRes = await fetchFn(`${base}/api/v1/datasets`, { headers });
    const dsText = await dsRes.text();
    if (!dsRes.ok) throw new Error(`GET datasets → ${dsRes.status}`);
    const datasets = JSON.parse(dsText);
    const list = Array.isArray(datasets) ? datasets : datasets?.datasets || [];
    const match = list.find((d) => (d.name || d.dataset_name) === dataset);
    if (!match?.id) throw new Error(`Cognee dataset not found for bank ${bankId}`);
    const q = query.toLowerCase();
    const items = [];
    let offset = 0;
    while (items.length < limit) {
      const pageRes = await fetchFn(`${base}/api/v1/datasets/${match.id}/data?limit=50&offset=${offset}`, { headers });
      if (!pageRes.ok) break;
      const page = await pageRes.json();
      const rows = Array.isArray(page) ? page : page?.data || [];
      if (!rows.length) break;
      for (const row of rows) {
        const text = row?.text ?? row?.content ?? row?.data ?? "";
        if (String(text).toLowerCase().includes(q)) {
          items.push({ id: row.id ?? null, type: null, text: String(text) });
          if (items.length >= limit) break;
        }
      }
      offset += rows.length;
      if (rows.length < 50) break;
    }
    return { bank_id: bankId, query, mode: "list", items };
  }
  throw new Error(`notebooklm MCP does not support provider ${ctx.provider}`);
}
