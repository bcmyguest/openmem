#!/usr/bin/env node
/**
 * Opt-in stdio MCP: read-only Cognee health + search against the local REST API.
 * Base URL: COGNEE_API_URL / COGNEE_URL, else http://127.0.0.1:${COGNEE_PORT|8766}.
 * Optional COGNEE_API_KEY → X-Api-Key (never written to mcp.json). Zero npm deps.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";
import { DEFAULT_PORT } from "../providers/cognee/lib/state.mjs";

export { DEFAULT_PORT };

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveBaseUrl(env = process.env) {
  const fromUrl = String(env.COGNEE_API_URL || env.COGNEE_URL || "").trim();
  if (fromUrl) return fromUrl.replace(/\/+$/, "");
  const port = String(env.COGNEE_PORT || DEFAULT_PORT).trim() || String(DEFAULT_PORT);
  return `http://127.0.0.1:${port}`;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Record<string, string>}
 */
export function authHeaders(env = process.env) {
  const key = String(env.COGNEE_API_KEY || "").trim();
  return key ? { "X-Api-Key": key } : {};
}

/**
 * @param {string} baseUrl
 * @param {typeof fetch} [fetchFn]
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function healthCheck(baseUrl, fetchFn = fetch, env = process.env) {
  const res = await fetchFn(`${baseUrl.replace(/\/+$/, "")}/health`, {
    headers: { ...authHeaders(env) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET /health → ${res.status}: ${text.slice(0, 400)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * @param {string} baseUrl
 * @param {{ query: string, searchType?: string, datasets?: string[] }} body
 * @param {typeof fetch} [fetchFn]
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function search(baseUrl, body, fetchFn = fetch, env = process.env) {
  /** @type {Record<string, unknown>} */
  const payload = {
    searchType: body.searchType || "GRAPH_COMPLETION",
    query: body.query,
  };
  if (Array.isArray(body.datasets) && body.datasets.length) {
    payload.datasets = body.datasets.map(String);
  }
  const res = await fetchFn(`${baseUrl.replace(/\/+$/, "")}/api/v1/search`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(env) },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST /api/v1/search → ${res.status}: ${text.slice(0, 400)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const TOOLS = [
  {
    name: "cognee_health",
    description: "GET /health on the local Cognee REST API. Confirms the stack is up.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "cognee_search",
    description:
      "POST /api/v1/search (read-only). Args: query (required), optional searchType (default GRAPH_COMPLETION), optional datasets[]. Does not add or cognify.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search / completion query" },
        searchType: {
          type: "string",
          description: "Cognee searchType (default GRAPH_COMPLETION)",
        },
        datasets: {
          type: "array",
          items: { type: "string" },
          description: "Optional dataset name filter",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

function textResult(value, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }], isError };
}

/**
 * @param {{ baseUrl: string, env?: NodeJS.ProcessEnv }} access
 * @param {string} name
 * @param {Record<string, unknown>} [args]
 * @param {typeof fetch} [fetchFn]
 */
export async function callTool(access, name, args = {}, fetchFn = fetch) {
  const env = access.env || process.env;
  if (name === "cognee_health") {
    return textResult(await healthCheck(access.baseUrl, fetchFn, env));
  }
  if (name === "cognee_search") {
    const query = String(args.query || "").trim();
    if (!query) return textResult("query is required", true);
    /** @type {{ query: string, searchType?: string, datasets?: string[] }} */
    const body = { query };
    if (args.searchType != null && String(args.searchType).trim()) {
      body.searchType = String(args.searchType).trim();
    }
    if (Array.isArray(args.datasets)) {
      body.datasets = args.datasets.map(String);
    }
    return textResult({
      query,
      searchType: body.searchType || "GRAPH_COMPLETION",
      result: await search(access.baseUrl, body, fetchFn, env),
    });
  }
  return textResult(`unknown tool: ${name}`, true);
}

/**
 * @param {Record<string, any>} msg
 * @param {{ baseUrl: string, env?: NodeJS.ProcessEnv }} access
 * @param {typeof fetch} [fetchFn]
 */
export async function handleMessage(msg, access, fetchFn = fetch) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    const protocolVersion =
      typeof params?.protocolVersion === "string" && params.protocolVersion
        ? params.protocolVersion
        : "2024-11-05";
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "cognee", version: "0.1.0" },
      },
    };
  }
  if (method === "notifications/initialized" || method === "initialized") return null;
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  if (method === "tools/call") {
    try {
      return { jsonrpc: "2.0", id, result: await callTool(access, params?.name, params?.arguments || {}, fetchFn) };
    } catch (err) {
      return { jsonrpc: "2.0", id, result: textResult(err instanceof Error ? err.message : String(err), true) };
    }
  }
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (id === undefined) return null;
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}

/** @param {"ndjson" | "content-length"} framing */
function writeMessage(obj, framing = "ndjson") {
  if (obj == null) return;
  const body = JSON.stringify(obj);
  // Cursor Agent CLI speaks NDJSON on stdio. Content-Length kept for LSP-style clients.
  if (framing === "content-length") {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
    return;
  }
  process.stdout.write(`${body}\n`);
}

/** Content-Length frames or NDJSON; reply using the same framing the request used. */
export async function serveStdio(input, onMsg) {
  let buf = Buffer.alloc(0);
  for await (const chunk of input) {
    buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (buf.length) {
      const asStr = buf.toString("utf8");
      const crlf = asStr.indexOf("\r\n\r\n");
      const lf = asStr.indexOf("\n\n");
      const headerEnd = crlf >= 0 ? crlf : lf;
      const sepLen = crlf >= 0 ? 4 : lf >= 0 ? 2 : -1;
      if (sepLen > 0 && /content-length\s*:/i.test(asStr.slice(0, headerEnd))) {
        const m = /Content-Length:\s*(\d+)/i.exec(asStr.slice(0, headerEnd));
        if (!m) {
          buf = buf.subarray(Buffer.byteLength(asStr.slice(0, headerEnd + sepLen), "utf8"));
          continue;
        }
        const len = Number(m[1]);
        const headerBytes = Buffer.byteLength(asStr.slice(0, headerEnd + sepLen), "utf8");
        if (buf.length < headerBytes + len) break;
        const body = buf.subarray(headerBytes, headerBytes + len).toString("utf8");
        buf = buf.subarray(headerBytes + len);
        let msg;
        try {
          msg = JSON.parse(body);
        } catch (err) {
          writeMessage(
            {
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: `Parse error: ${err instanceof Error ? err.message : err}` },
            },
            "content-length",
          );
          continue;
        }
        writeMessage(await onMsg(msg), "content-length");
        continue;
      }
      const nl = asStr.indexOf("\n");
      if (nl < 0) break;
      const line = asStr.slice(0, nl).trim();
      buf = buf.subarray(Buffer.byteLength(asStr.slice(0, nl + 1), "utf8"));
      if (!line.startsWith("{")) continue;
      try {
        writeMessage(await onMsg(JSON.parse(line)), "ndjson");
      } catch {
        /* skip bad line */
      }
    }
  }
}

async function main() {
  const baseUrl = resolveBaseUrl(process.env);
  const access = { baseUrl, env: process.env };
  process.stdin.resume();
  await serveStdio(process.stdin, (msg) => handleMessage(msg, access));
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`cognee-mcp: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
