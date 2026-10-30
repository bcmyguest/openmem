import { search as cogneeSearch } from "../cognee-mcp.mjs";
import { callMemoryConsolidate, callMemoryReflect } from "./memory-reflect-consolidate.mjs";
import { memoryExport, memoryImport } from "./portability.mjs";
import { KNOWLEDGE_MCP_TOOLS, KNOWLEDGE_TOOL_NAMES, callKnowledgeTool } from "./knowledge.mjs";
import { CONTEXT_STORE_MCP_TOOLS, CONTEXT_STORE_TOOL_NAMES, callContextStoreTool } from "./context-store.mjs";
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
    title: "Resolve project bank",
    description:
      "Resolve the project bank (user_id / dataset) and access policy for a workspace path. " +
      "Call it instead of guessing a bank name. Local mapping only.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        cwd: {
          type: "string",
          description: "Absolute workspace path (defaults to the MCP process working directory)",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "memory_add",
    title: "Store a memory",
    description:
      "Store durable facts, decisions or session notes in the active provider. " +
      "Pass bank from memory_project_scope for project work. Hindsight ingests async by default.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Plain text to store as a durable memory" },
        bank: {
          type: "string",
          description: "Hindsight bank or mem0 user_id / Cognee dataset scope (default: openmem-mcp)",
        },
        metadata: { type: "object", description: "Optional provider-specific metadata object" },
        async: {
          type: "boolean",
          description:
            "Hindsight only: true (default) returns after enqueueing ingest; false waits for extraction (may hit MCP client timeouts).",
        },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_search",
    title: "Search memories",
    description:
      "Return ranked raw hits from stored memories. memory_recall suits questions; memory_reflect synthesizes an answer.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query text" },
        bank: { type: "string", description: "Optional bank / user_id / dataset scope" },
        limit: { type: "number", description: "Max hits where the provider supports it" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_recall",
    title: "Recall context for a question",
    description:
      "Retrieve stored context for a natural-language question (Hindsight recall; search on mem0 and Cognee).",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Question or topic to recall context for" },
        bank: { type: "string", description: "Optional bank / user_id / dataset scope" },
        limit: { type: "number", description: "Max items where supported" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_forget",
    title: "Delete memories",
    description:
      "Delete memories: mem0 needs memory_id; on Hindsight a bank without memory_id drops the whole bank. " +
      "Confirm with the user first. Not available on Cognee.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        memory_id: { type: "string", description: "Provider memory id (required for mem0 deletes)" },
        bank: {
          type: "string",
          description: "Hindsight bank to drop (when memory_id omitted), or mem0 user_id scope",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "memory_export",
    title: "Export memories (PMM)",
    description:
      "Export memories as PMM v1 JSON or JSONL for backup or migration. Pass bank for large stores.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["json", "jsonl"], description: "Serialization format (default json)" },
        bank: {
          type: "string",
          description:
            "Hindsight bank, mem0 user_id, or indexer bank for Cognee. Omit on Hindsight to export all banks.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "memory_import",
    title: "Import memories (PMM)",
    description:
      "Import a PMM v1 payload from memory_export. Content and scope carry over; embeddings and graphs do not.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        data: { type: "string", description: "Serialized PMM export (json or jsonl text)" },
        merge_strategy: {
          type: "string",
          enum: ["skip_duplicates", "overwrite"],
          description: "How to treat records that already exist (default skip_duplicates)",
        },
      },
      required: ["data"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_provider_status",
    title: "Provider status",
    description:
      "Report the active provider id and backend URL.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "memory_reflect",
    title: "Reflect / synthesize an answer",
    description:
      "Synthesize a reasoned answer from stored memories, with evidence. The answer is not stored.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Question to answer from memory" },
        bank: { type: "string", description: "Optional bank / user_id / dataset scope" },
        limit: { type: "number", description: "Max evidence items where supported" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_consolidate",
    title: "Consolidate / cognify",
    description:
      "Rebuild the provider's graph or index after bulk ingest (Cognee cognify; no-op on mem0).",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        bank: { type: "string", description: "Bank / dataset to consolidate (required for Cognee cognify)" },
      },
      additionalProperties: false,
    },
  },
  ...KNOWLEDGE_MCP_TOOLS,
  ...CONTEXT_STORE_MCP_TOOLS,
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

const DEFAULT_BANK = "openmem-mcp";

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

  if (CONTEXT_STORE_TOOL_NAMES.has(name)) {
    try {
      return textResult(await callContextStoreTool(name, args));
    } catch (err) {
      return textResult(err instanceof Error ? err.message : String(err), true);
    }
  }

  if (KNOWLEDGE_TOOL_NAMES.has(name)) {
    try {
      return textResult(await callKnowledgeTool(ctx, name, args, fetchFn));
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
          agent_id: "openmem-mcp",
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
        serverInfo: { name: "openmem", version: "0.6.4" },
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
