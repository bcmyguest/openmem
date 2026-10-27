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
    title: "Resolve project bank",
    description:
      "Resolve the OpenMem bank / user_id scope and session access policy for a workspace path. " +
      "Use before memory_add or memory_search when you need the project bank name. " +
      "Does not call the memory provider HTTP API — local mapping only. " +
      "Prefer this over guessing bank names; do not use for storing or searching memories.",
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
      "Write durable text into the active OpenMem provider (Hindsight bank, mem0 user_id, or Cognee dataset). " +
      "Use for facts, decisions, and session notes that should persist across turns. " +
      "Pass bank from memory_project_scope for project work; default scope is openmem-mcp. " +
      "Not for search or synthesis — use memory_search / memory_recall / memory_reflect. " +
      "On Hindsight, async ingest is the default so the tool returns before LLM extraction finishes.",
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
      "Run a semantic or graph search over stored memories in the active provider and return ranked hits. " +
      "Use when you need raw matches for a query. Prefer memory_recall for question-shaped context retrieval, " +
      "and memory_reflect when you need a synthesized answer with evidence. Does not write or delete memories.",
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
      "Retrieve memory context for a natural-language question. On Hindsight this calls the recall API; " +
      "on mem0 and Cognee it searches and returns the hits. Use for grounding an answer in stored context. " +
      "Prefer memory_search for keyword/semantic hit lists; prefer memory_reflect for LLM synthesis of those hits. " +
      "Read-only — does not store or delete.",
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
      "Delete stored memories. Destructive: on mem0 requires memory_id; on Hindsight, bank without memory_id drops that entire bank. " +
      "Confirm the id or bank with the user before calling. Cognee delete is not exposed here. " +
      "Not for export — use memory_export first if you need a backup.",
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
      "Export memories as Personal Memory Manifest (PMM) v1 JSON or JSONL for backup or cross-provider import. " +
      "Hindsight lists /memories/list; mem0 GET /memories; Cognee dataset /data. " +
      "Use before memory_import or openmem switch. Read-only against the provider store; large banks may be heavy — pass bank when possible. " +
      "Does not change provider selection.",
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
      "Import a PMM v1 payload into the active provider. Best-effort across providers (content + scope_key mapped; embeddings/graphs not preserved). " +
      "Use after memory_export when migrating or restoring. merge_strategy skip_duplicates (default) avoids re-adding known mem0 ids/fingerprints; " +
      "overwrite re-imports and may duplicate on backends without upsert. Not a substitute for openmem switch.",
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
      "Report the active MEMORY_PROVIDER id and resolved backend base URL (never secrets or API keys). " +
      "Use to verify which engine OpenMem is talking to before add/search. Read-only local/config resolution.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "memory_reflect",
    title: "Reflect / synthesize an answer",
    description:
      "Synthesize an answer from stored memories for a question. Hindsight uses native reflect with evidence; " +
      "mem0/Cognee search first, then optional LiteLLM synthesis when PM_LLM_URL / stack LiteLLM is configured. " +
      "Use when the user wants a reasoned answer, not a raw hit list (memory_search) or plain context dump (memory_recall). " +
      "Does not permanently store the synthesized answer unless you call memory_add afterward.",
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
      "Run provider maintenance that improves searchability of already-ingested data. " +
      "Cognee: cognify for a bank/dataset. Hindsight: reports LiteLLM route notes. mem0: no-op. " +
      "Use after bulk memory_add or indexing when the provider needs a graph/index rebuild. " +
      "Not for reading memories — use memory_search/recall after consolidate completes.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        bank: { type: "string", description: "Bank / dataset to consolidate (required for Cognee cognify)" },
      },
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
