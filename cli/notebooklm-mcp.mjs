#!/usr/bin/env node
/**
 * Opt-in stdio MCP: list/search notebooklm::* banks on local Hindsight.
 * Config: ~/.hindsight/coding-agent.json (apiUrl + notebooklmAccess). Zero npm deps.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PREFIX = "notebooklm::";
export const DEFAULT_API_URL = "http://127.0.0.1:8888";
export const DEFAULT_CONFIG = path.join(os.homedir(), ".hindsight", "coding-agent.json");

export function isNotebooklmBank(bankId) {
  return typeof bankId === "string" && bankId.startsWith(PREFIX);
}

export function notebooklmSlug(bankId) {
  return isNotebooklmBank(bankId) ? bankId.slice(PREFIX.length) : null;
}

/** @param {string} bankId @param {string[] | undefined} allowlist */
export function bankAllowed(bankId, allowlist) {
  if (!isNotebooklmBank(bankId)) return false;
  const list = Array.isArray(allowlist) && allowlist.length ? allowlist : ["*"];
  if (list.includes("*")) return true;
  const slug = notebooklmSlug(bankId);
  return list.some((e) => e === bankId || e === slug);
}

/** @param {Array<{ bank_id?: string, id?: string, name?: string }>} banks @param {string[]} allowlist */
export function filterNotebooklmBanks(banks, allowlist) {
  return (banks || []).filter((b) => bankAllowed(b.bank_id || b.id || b.name || "", allowlist));
}

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

/** @param {string} apiUrl @param {typeof fetch} [fetchFn] */
export async function listBanks(apiUrl, fetchFn = fetch) {
  const res = await fetchFn(`${apiUrl}/v1/default/banks`);
  if (!res.ok) throw new Error(`GET /v1/default/banks → ${res.status} ${res.statusText}`);
  const data = await res.json();
  return Array.isArray(data?.banks) ? data.banks : Array.isArray(data) ? data : [];
}

/** @param {string} apiUrl @param {string} bankId @param {string} query @param {typeof fetch} [fetchFn] */
export async function recallBank(apiUrl, bankId, query, fetchFn = fetch) {
  const url = `${apiUrl}/v1/default/banks/${encodeURIComponent(bankId)}/memories/recall`;
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST recall ${bankId} → ${res.status}: ${text.slice(0, 400)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const TOOLS = [
  {
    name: "notebooklm_list_banks",
    description:
      "List notebooklm::* banks on local Hindsight (filtered by notebooklmAccess.banks). Returns bank_id and fact_count.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "notebooklm_search",
    description:
      "Recall on one allowlisted notebooklm::* bank. Args: bank_id + query. Read-only; does not replace coding-agent::* memory.",
    inputSchema: {
      type: "object",
      properties: {
        bank_id: { type: "string", description: "e.g. notebooklm::my-notebook" },
        query: { type: "string" },
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

/** @param {{ apiUrl: string, banks: string[] }} access @param {string} name @param {Record<string, unknown>} [args] @param {typeof fetch} [fetchFn] */
export async function callTool(access, name, args = {}, fetchFn = fetch) {
  if (name === "notebooklm_list_banks") {
    const filtered = filterNotebooklmBanks(await listBanks(access.apiUrl, fetchFn), access.banks).map((b) => ({
      bank_id: b.bank_id || b.id || b.name,
      fact_count: b.fact_count ?? null,
      name: b.name ?? null,
    }));
    return textResult({ banks: filtered, count: filtered.length });
  }
  if (name === "notebooklm_search") {
    const bankId = String(args.bank_id || "");
    const query = String(args.query || "");
    if (!bankId || !query) return textResult("bank_id and query are required", true);
    if (!bankAllowed(bankId, access.banks)) {
      return textResult(`bank not allowlisted or not a notebooklm::* bank: ${bankId}`, true);
    }
    return textResult({ bank_id: bankId, query, result: await recallBank(access.apiUrl, bankId, query, fetchFn) });
  }
  return textResult(`unknown tool: ${name}`, true);
}

/** @param {Record<string, any>} msg @param {{ apiUrl: string, banks: string[] }} access @param {typeof fetch} [fetchFn] */
export async function handleMessage(msg, access, fetchFn = fetch) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
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

function writeMessage(obj) {
  if (obj == null) return;
  const body = JSON.stringify(obj);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

/** Content-Length frames; NDJSON fallback. */
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
          writeMessage({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: `Parse error: ${err instanceof Error ? err.message : err}` },
          });
          continue;
        }
        writeMessage(await onMsg(msg));
        continue;
      }
      const nl = asStr.indexOf("\n");
      if (nl < 0) break;
      const line = asStr.slice(0, nl).trim();
      buf = buf.subarray(Buffer.byteLength(asStr.slice(0, nl + 1), "utf8"));
      if (!line.startsWith("{")) continue;
      try {
        writeMessage(await onMsg(JSON.parse(line)));
      } catch {
        /* skip bad line */
      }
    }
  }
}

async function main() {
  const configPath = process.env.HINDSIGHT_CODING_AGENT_JSON || DEFAULT_CONFIG;
  let cfg;
  try {
    cfg = loadCodingAgentConfig(configPath);
  } catch (err) {
    console.error(`notebooklm-mcp: cannot read ${configPath}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  const access = resolveAccess(cfg);
  if (!access.enabled) {
    console.error(
      "notebooklm-mcp: notebooklmAccess.enabled is not true in coding-agent.json; " +
        "set notebooklmAccess.enabled to true to use this MCP (opt-in).",
    );
    process.exit(1);
  }
  process.stdin.resume();
  await serveStdio(process.stdin, (msg) => handleMessage(msg, access));
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(thisFile)) {
  main().catch((err) => {
    console.error(`notebooklm-mcp: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
