import { search as cogneeSearch } from "../cognee-mcp.mjs";
import { callMemoryConsolidate, callMemoryReflect } from "./memory-reflect-consolidate.mjs";
import { memoryExport, memoryImport } from "./portability.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDocument } from "yaml";
import { bankFromCwd } from "../coding-agent/bank-from-cwd.mjs";
import { accessAllowed, accessConfigPath, readAccessConfig } from "../coding-agent/access-policy.mjs";
import { fileURLToPath } from "node:url";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const UNIFIED_MCP_TOOLS = [
  {
    name: "memory_project_scope",
    description: "Read the local project bank mapping and session access policy for a workspace. Makes no memory-provider calls.",
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string", description: "Absolute workspace path (defaults to the MCP process working directory)" } },
      additionalProperties: false,
    },
  },
  {
    name: "memory_add",
    description:
      "Store text in the active memory provider (Hindsight bank, mem0 user scope, or Cognee dataset ingest when supported). " +
      "On Hindsight, defaults to async ingest so the MCP returns before LLM extraction finishes (avoids client timeouts).",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Text to remember" },
        bank: { type: "string", description: "Hindsight bank or mem0 user_id scope (default: personal-memory-mcp)" },
        metadata: { type: "object", description: "Optional provider-specific metadata" },
        async: {
          type: "boolean",
          description:
            "Hindsight only: queue background ingest (default true). Set false to wait for extraction (slow; may hit MCP timeouts).",
        },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_search",
    description: "Semantic or graph search over memories in the active provider.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        bank: { type: "string", description: "Optional bank / user_id scope" },
        limit: { type: "number", description: "Max results where supported" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_recall",
    description:
      "Retrieve context for a question (Hindsight recall API; mem0/Cognee use search under the hood).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        bank: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_forget",
    description: "Delete a memory by id (mem0) or drop an entire Hindsight bank when bank is set without memory_id.",
    inputSchema: {
      type: "object",
      properties: {
        memory_id: { type: "string", description: "Provider memory id (mem0)" },
        bank: { type: "string", description: "Hindsight bank to delete, or mem0 user_id scope for bulk delete" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "memory_export",
    description:
      "Export memories as PMM v1 (json/jsonl). Hindsight lists via /memories/list; mem0 GET /memories; Cognee dataset /data.",
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["json", "jsonl"], description: "Serialization (default json)" },
        bank: {
          type: "string",
          description: "Hindsight bank, mem0 user_id, or indexer bank for Cognee dataset mapping. Omit on Hindsight to export all banks.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "memory_import",
    description: "Import PMM v1 payload into the active provider (best-effort cross-provider).",
    inputSchema: {
      type: "object",
      properties: {
        data: { type: "string", description: "Serialized export payload" },
        merge_strategy: { type: "string", enum: ["skip_duplicates", "overwrite"] },
      },
      required: ["data"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_provider_status",
    description: "Report active MEMORY_PROVIDER and resolved backend URL (no secrets).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "memory_reflect",
    description:
      "Synthesize session context for a question. Hindsight uses recall; mem0/Cognee search then optional LiteLLM synthesis (PM_LLM_URL / stack LiteLLM).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        bank: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_consolidate",
    description: "Provider maintenance: Cognee cognify for a bank/dataset; Hindsight notes LiteLLM route; mem0 skips.",
    inputSchema: {
      type: "object",
      properties: { bank: { type: "string" } },
      additionalProperties: false,
    },
  },
];

export function textResult(value, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }], isError };
}

/**
 * @param {string} url
 * @param {RequestInit} init
 * @param {typeof fetch} [fetchFn]
 */
async function httpJson(url, init, fetchFn = fetch) {
  const res = await fetchFn(url, init);
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok) {
    const detail = typeof json === "string" ? json : JSON.stringify(json);
    throw new Error(`${init.method || "GET"} ${url} → ${res.status}: ${String(detail).slice(0, 400)}`);
  }
  return json;
}

const DEFAULT_BANK = "personal-memory-mcp";

/** Hindsight ingest: default async so Cursor/Claude MCP clients do not time out on extraction. */
function hindsightMemoryAddAsync(args) {
  if (args.async === true) return true;
  if (args.async === false) return false;
  const env = String(process.env.PM_MEMORY_ADD_ASYNC || "").trim().toLowerCase();
  if (env === "0" || env === "false" || env === "no") return false;
  if (env === "1" || env === "true" || env === "yes") return true;
  return true;
}

/**
 * @param {ReturnType<import("./context.mjs").resolveMcpContext>} ctx
 * @param {string} name
 * @param {Record<string, unknown>} [args]
 * @param {typeof fetch} [fetchFn]
 */
export async function callUnifiedTool(ctx, name, args = {}, fetchFn = fetch) {
  if (name === "memory_project_scope") {
    const cwd = args.cwd === undefined ? process.cwd() : args.cwd;
    if (typeof cwd !== "string" || !cwd.trim() || !path.isAbsolute(cwd)) {
      return textResult("cwd must be an absolute workspace path", true);
    }
    const home = process.env.HOME || os.homedir();
    const accessConfig = readAccessConfig(home);
    const indexPath = process.env.HINDSIGHT_INDEX_CONFIG
      ? path.resolve(process.env.HINDSIGHT_INDEX_CONFIG.replace(/^~(?=$|\/)/, home))
      : fs.existsSync(path.join(home, ".config", "hindsight", "index.yml"))
        ? path.join(home, ".config", "hindsight", "index.yml")
        : path.join(PKG_ROOT, "config", "index.yml");
    let indexBanks;
    try {
      const doc = parseDocument(fs.readFileSync(indexPath, "utf8"), { uniqueKeys: true, version: "1.1" });
      if (doc.errors.length) throw doc.errors[0];
      indexBanks = doc.toJS()?.banks;
    } catch (err) {
      return textResult(`Unable to read active index.yml (${indexPath}): ${err.message}`, true);
    }
    const permitted = accessAllowed(cwd, accessConfig);
    return textResult({
      cwd: path.resolve(cwd),
      bank: bankFromCwd(cwd, { home, env: process.env, banks: indexBanks || {}, mapPathToBank: accessConfig?.mapPathToBank }),
      accessPermitted: permitted,
      accessConfigPath: accessConfigPath(home),
      personalMemoryMapping: accessConfig?.mapPathToBank || {},
      indexConfigPath: indexPath,
      indexBanks: indexBanks || {},
      policyConfigValid: accessConfig !== null,
    });
  }
  if (name === "memory_export") {
    const out = await memoryExport(ctx, args, fetchFn);
    return textResult(typeof out === "string" ? out : out);
  }
  if (name === "memory_import") {
    const data = String(args.data || "");
    if (!data.trim()) return textResult("data is required", true);
    const summary = await memoryImport(ctx, data, args, fetchFn, callUnifiedTool);
    return textResult(summary);
  }
  if (name === "memory_provider_status") {
    return textResult({
      provider: ctx.provider,
      hindsightUrl: ctx.hindsightUrl,
      mem0BaseUrl: ctx.mem0?.baseUrl,
      cogneeBaseUrl: ctx.cognee?.baseUrl,
    });
  }
  if (name === "memory_reflect") {
    try {
      const payload = await callMemoryReflect(ctx, args, (n, a, f) => callUnifiedTool(ctx, n, a, f), fetchFn);
      return textResult(payload);
    } catch (err) {
      return textResult(err instanceof Error ? err.message : String(err), true);
    }
  }
  if (name === "memory_consolidate") {
    try {
      return textResult(await callMemoryConsolidate(ctx, args, fetchFn));
    } catch (err) {
      return textResult(err instanceof Error ? err.message : String(err), true);
    }
  }

  if (ctx.provider === "hindsight") {
    return callHindsight(ctx, name, args, fetchFn);
  }
  if (ctx.provider === "mem0") {
    return callMem0(ctx, name, args, fetchFn);
  }
  if (ctx.provider === "cognee") {
    return callCognee(ctx, name, args, fetchFn);
  }
  return textResult(`unsupported provider "${ctx.provider}"`, true);
}

/**
 * @param {ReturnType<import("./context.mjs").resolveMcpContext>} ctx
 */
async function callHindsight(ctx, name, args, fetchFn) {
  const base = ctx.hindsightUrl;
  if (!base) return textResult("Hindsight API URL not configured", true);
  const bank = String(args.bank || DEFAULT_BANK).trim() || DEFAULT_BANK;
  const encBank = encodeURIComponent(bank);

  if (name === "memory_add") {
    const content = String(args.content || "").trim();
    if (!content) return textResult("content is required", true);
    const json = await httpJson(
      `${base}/v1/default/banks/${encBank}/memories`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: [{ content }], async: hindsightMemoryAddAsync(args) }),
      },
      fetchFn,
    );
    return textResult({ provider: "hindsight", bank, result: json });
  }
  if (name === "memory_search" || name === "memory_recall") {
    const query = String(args.query || "").trim();
    if (!query) return textResult("query is required", true);
    const json = await httpJson(
      `${base}/v1/default/banks/${encBank}/memories/recall`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, ...(args.budget ? { budget: args.budget } : {}),
          ...(args.maxTokens ? { max_tokens: args.maxTokens } : {}) }),
      },
      fetchFn,
    );
    return textResult({ provider: "hindsight", bank, query, result: json });
  }
  if (name === "memory_forget") {
    const memoryId = String(args.memory_id || "").trim();
    if (memoryId) {
      return textResult(
        "Hindsight per-memory delete is not wired in this MCP yet; pass bank to delete a test bank or use the Hindsight API/docs.",
        true,
      );
    }
    const targetBank = String(args.bank || "").trim();
    if (!targetBank) return textResult("memory_id or bank is required for Hindsight", true);
    await httpJson(
      `${base}/v1/default/banks/${encodeURIComponent(targetBank)}`,
      { method: "DELETE" },
      fetchFn,
    );
    return textResult({ provider: "hindsight", deleted_bank: targetBank });
  }
  return textResult(`unknown tool: ${name}`, true);
}

async function callMem0(ctx, name, args, fetchFn) {
  const base = ctx.mem0?.baseUrl;
  if (!base) return textResult("mem0 API URL not configured", true);
  const key = ctx.mem0?.apiKey;
  /** @type {Record<string, string>} */
  const headers = { "content-type": "application/json" };
  if (key) headers["X-API-Key"] = key;
  const userId = String(args.bank || DEFAULT_BANK).trim() || DEFAULT_BANK;

  if (name === "memory_add") {
    const content = String(args.content || "").trim();
    if (!content) return textResult("content is required", true);
    const json = await httpJson(
      `${base}/memories`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          messages: [{ role: "user", content }],
          user_id: userId,
          agent_id: "personal-memory-mcp",
          infer: false,
        }),
      },
      fetchFn,
    );
    return textResult({ provider: "mem0", user_id: userId, result: json });
  }
  if (name === "memory_search" || name === "memory_recall") {
    const query = String(args.query || "").trim();
    if (!query) return textResult("query is required", true);
    const limit = Number(args.limit) > 0 ? Number(args.limit) : 10;
    const json = await httpJson(
      `${base}/search`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ query, filters: { user_id: userId }, top_k: limit }),
      },
      fetchFn,
    );
    return textResult({ provider: "mem0", user_id: userId, query, result: json });
  }
  if (name === "memory_forget") {
    const memoryId = String(args.memory_id || "").trim();
    if (memoryId) {
      await httpJson(`${base}/memories/${encodeURIComponent(memoryId)}`, { method: "DELETE", headers }, fetchFn);
      return textResult({ provider: "mem0", deleted: memoryId });
    }
    return textResult("mem0 bulk forget requires memory_id (use mem0 API or dashboard for scoped purge)", true);
  }
  return textResult(`unknown tool: ${name}`, true);
}

async function callCognee(ctx, name, args, fetchFn) {
  const base = ctx.cognee?.baseUrl;
  if (!base) return textResult("Cognee API URL not configured", true);
  const env = ctx.cognee?.apiKey ? { COGNEE_API_KEY: ctx.cognee.apiKey } : process.env;

  if (name === "memory_add") {
    const content = String(args.content || "").trim();
    if (!content) return textResult("content is required", true);
    const dataset = String(args.bank || DEFAULT_BANK).trim() || DEFAULT_BANK;
    // Cognee 1.6.x add is multipart/form-urlencoded: JSON bodies ignore datasetName.
    // Text goes in raw_data; file uploads use the data field (see Cognee OpenAPI).
    const form = new FormData();
    form.set("datasetName", dataset);
    form.set("raw_data", content);
    const headers = {};
    if (ctx.cognee?.apiKey) headers["X-Api-Key"] = ctx.cognee.apiKey;
    const json = await httpJson(`${base}/api/v1/add`, { method: "POST", headers, body: form }, fetchFn);
    return textResult({
      provider: "cognee",
      dataset,
      result: json,
      note: "Run cognify on the dataset for graph search to see new material.",
    });
  }
  if (name === "memory_search" || name === "memory_recall") {
    const query = String(args.query || "").trim();
    if (!query) return textResult("query is required", true);
    const datasets = args.bank ? [String(args.bank)] : undefined;
    const result = await cogneeSearch(base, { query, datasets }, fetchFn, env);
    return textResult({ provider: "cognee", query, result });
  }
  if (name === "memory_forget") {
    return textResult("Cognee delete is not exposed in unified MCP yet; use Cognee API or indexer.", true);
  }
  return textResult(`unknown tool: ${name}`, true);
}

/**
 * @param {Record<string, unknown>} msg
 * @param {ReturnType<import("./context.mjs").resolveMcpContext>} ctx
 * @param {typeof fetch} [fetchFn]
 */
export async function handleUnifiedMessage(msg, ctx, fetchFn = fetch) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    const protocolVersion =
      typeof params?.protocolVersion === "string" && params.protocolVersion ? params.protocolVersion : "2024-11-05";
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "personal-memory", version: "0.1.0" },
      },
    };
  }
  if (method === "notifications/initialized" || method === "initialized") return null;
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: UNIFIED_MCP_TOOLS } };
  if (method === "tools/call") {
    try {
      const result = await callUnifiedTool(ctx, String(params?.name || ""), params?.arguments || {}, fetchFn);
      return { jsonrpc: "2.0", id, result };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        result: textResult(err instanceof Error ? err.message : String(err), true),
      };
    }
  }
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (id === undefined) return null;
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}
