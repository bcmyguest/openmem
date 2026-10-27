#!/usr/bin/env node
/**
 * Opt-in stdio MCP: list/search notebooklm::* banks on the active memory provider.
 * Config: ~/.hindsight/coding-agent.json (notebooklmAccess); API from MEMORY_PROVIDER + stack env.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";
import { resolveMcpContext } from "./mcp/context.mjs";
import { listNotebooklmBanks, searchNotebooklmBank } from "./mcp/notebooklm-provider.mjs";
import { resolveStackRoot } from "./stack.mjs";

export { PREFIX, bankAllowed, filterNotebooklmBanks, isNotebooklmBank, notebooklmSlug } from "./mcp/notebooklm-banks.mjs";
export { listBanks, listMemories, recallBank } from "./mcp/notebooklm-hindsight-rest.mjs";

export const DEFAULT_API_URL = "http://127.0.0.1:8888";
export const DEFAULT_CONFIG = path.join(os.homedir(), ".hindsight", "coding-agent.json");

/** @param {Record<string, any> | null | undefined} cfg */
export function resolveAccess(cfg) {
  const access = cfg?.notebooklmAccess && typeof cfg.notebooklmAccess === "object" ? cfg.notebooklmAccess : {};
  return {
    enabled: access.enabled === true,
    banks: Array.isArray(access.banks) && access.banks.length ? access.banks.map(String) : ["*"],
    apiUrl: String(cfg?.apiUrl || DEFAULT_API_URL).replace(/\/$/, ""),
  };
}

export function loadCodingAgentConfig(configPath = DEFAULT_CONFIG) {
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

import { bankAllowed } from "./mcp/notebooklm-banks.mjs";

const TOOLS = [
  {
    name: "notebooklm_list_banks",
    description:
      "List notebooklm::* banks on the active memory provider (filtered by notebooklmAccess.banks). Returns bank_id and fact_count.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "notebooklm_search",
    description:
      "Search one allowlisted notebooklm::* bank. Default mode=list is fast full-text (memories/list, no LLM). " +
      "Use mode=recall only when you need Hindsight LLM synthesis — often 30–90s on CPU and may hit MCP timeouts. " +
      "Prefer short keyword queries (e.g. \"time series\") over long phrases. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        bank_id: { type: "string", description: "e.g. notebooklm::my-notebook" },
        query: { type: "string", description: "Full-text keywords (list) or natural-language (recall)" },
        mode: {
          type: "string",
          enum: ["list", "recall"],
          description: "list (default, fast) or recall (LLM, slow)",
        },
        limit: { type: "integer", description: "list mode page size (default 20)" },
      },
      required: ["bank_id", "query"],
      additionalProperties: false,
    },
  },
];

function textResult(value, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }], isError };
}

/** @param {{ apiUrl: string, banks: string[], enabled?: boolean, ctx?: import("./mcp/context.mjs").McpContext }} access @param {string} name @param {Record<string, unknown>} [args] @param {typeof fetch} [fetchFn] */
export async function callTool(access, name, args = {}, fetchFn = fetch) {
  if (access.enabled !== true) {
    return textResult(
      "notebooklmAccess.enabled is not true in coding-agent.json; " +
        "set notebooklmAccess.enabled to true (and keep ~/.hindsight/coding-agent.json as a real file, not a symlink to the shipped template).",
      true,
    );
  }
  if (!access.ctx) return textResult("MCP context not initialized (internal error)", true);
  if (name === "notebooklm_list_banks") {
    const filtered = await listNotebooklmBanks(access.ctx, access.banks, fetchFn);
    return textResult({ banks: filtered, count: filtered.length, provider: access.ctx.provider });
  }
  if (name === "notebooklm_search") {
    const bankId = String(args.bank_id || "");
    const query = String(args.query || "");
    const mode = String(args.mode || "list").toLowerCase() === "recall" ? "recall" : "list";
    if (!bankId || !query) return textResult("bank_id and query are required", true);
    if (!bankAllowed(bankId, access.banks)) {
      return textResult(`bank not allowlisted or not a notebooklm::* bank: ${bankId}`, true);
    }
    const limit = args.limit != null ? Number(args.limit) : 20;
    const payload = await searchNotebooklmBank(
      access.ctx,
      { bankId, query, mode, limit, hindsightApiUrl: access.apiUrl },
      fetchFn,
    );
    return textResult(payload);
  }
  return textResult(`unknown tool: ${name}`, true);
}

/** @param {Record<string, any>} msg @param {{ apiUrl: string, banks: string[] }} access @param {typeof fetch} [fetchFn] */
export async function handleMessage(msg, access, fetchFn = fetch) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    // Echo client protocol (Cursor Agent uses 2025-11-25); fall back for older clients.
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
        serverInfo: { name: "notebooklm", version: "0.1.0" },
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
  // Cursor Agent CLI speaks NDJSON on stdio (same as Hindsight MCP). Content-Length is kept for LSP-style clients.
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
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const configPath = process.env.HINDSIGHT_CODING_AGENT_JSON || DEFAULT_CONFIG;
  let cfg = null;
  let access;
  try {
    cfg = loadCodingAgentConfig(configPath);
    access = resolveAccess(cfg);
    const home = process.env.HOME || os.homedir();
    const stack = resolveStackRoot({ pkgRoot, env: process.env, home });
    access.ctx = resolveMcpContext({ home, stackRoot: stack.root, repoRoot: pkgRoot, env: process.env });
  } catch (err) {
    // Stay alive so Cursor's MCP client does not report "Connection closed".
    // Tools return isError until coding-agent.json is readable.
    console.error(`notebooklm-mcp: cannot read ${configPath}: ${err instanceof Error ? err.message : err}`);
    access = { enabled: false, banks: ["*"], apiUrl: DEFAULT_API_URL, ctx: null };
  }
  if (!access.enabled) {
    console.error(
      "notebooklm-mcp: notebooklmAccess.enabled is not true; tools will error until it is enabled " +
        `(config: ${configPath}).`,
    );
  }
  process.stdin.resume();
  await serveStdio(process.stdin, (msg) => handleMessage(msg, access));
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`notebooklm-mcp: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
