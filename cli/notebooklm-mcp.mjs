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

/**
 * Fast full-text list (no LLM). Prefer this for MCP — local recall often exceeds
 * Cursor's tool timeout (~30–60s) when memory-reflect runs on CPU.
 * @param {string} apiUrl @param {string} bankId @param {string} query
 * @param {{ limit?: number, offset?: number }} [opts] @param {typeof fetch} [fetchFn]
 */
export async function listMemories(apiUrl, bankId, query, opts = {}, fetchFn = fetch) {
  const limit = Number.isFinite(opts.limit) ? Math.max(0, Math.floor(opts.limit)) : 20;
  const offset = Number.isFinite(opts.offset) ? Math.max(0, Math.floor(opts.offset)) : 0;
  const qs = new URLSearchParams({ q: query, limit: String(limit), offset: String(offset) });
  const url = `${apiUrl}/v1/default/banks/${encodeURIComponent(bankId)}/memories/list?${qs}`;
  const res = await fetchFn(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`GET memories/list ${bankId} → ${res.status}: ${text.slice(0, 400)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** @param {string} apiUrl @param {string} bankId @param {string} query @param {typeof fetch} [fetchFn] @param {{ budget?: string, max_tokens?: number }} [opts] */
export async function recallBank(apiUrl, bankId, query, fetchFn = fetch, opts = {}) {
  const url = `${apiUrl}/v1/default/banks/${encodeURIComponent(bankId)}/memories/recall`;
  const body = {
    query,
    budget: opts.budget || "low",
    max_tokens: opts.max_tokens ?? 1024,
    include: { entities: null, chunks: null, source_facts: null },
  };
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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

/** @param {{ apiUrl: string, banks: string[], enabled?: boolean }} access @param {string} name @param {Record<string, unknown>} [args] @param {typeof fetch} [fetchFn] */
export async function callTool(access, name, args = {}, fetchFn = fetch) {
  if (access.enabled !== true) {
    return textResult(
      "notebooklmAccess.enabled is not true in coding-agent.json; " +
        "set notebooklmAccess.enabled to true (and keep ~/.hindsight/coding-agent.json as a real file, not a symlink to the shipped template).",
      true,
    );
  }
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
    const mode = String(args.mode || "list").toLowerCase() === "recall" ? "recall" : "list";
    if (!bankId || !query) return textResult("bank_id and query are required", true);
    if (!bankAllowed(bankId, access.banks)) {
      return textResult(`bank not allowlisted or not a notebooklm::* bank: ${bankId}`, true);
    }
    if (mode === "recall") {
      return textResult({
        bank_id: bankId,
        query,
        mode,
        result: await recallBank(access.apiUrl, bankId, query, fetchFn),
      });
    }
    const limit = args.limit != null ? Number(args.limit) : 20;
    const listed = await listMemories(access.apiUrl, bankId, query, { limit }, fetchFn);
    const items = Array.isArray(listed?.items)
      ? listed.items.map((m) => ({
          id: m.id ?? m.memory_id ?? null,
          type: m.type ?? null,
          text: m.text ?? m.content ?? null,
        }))
      : listed;
    return textResult({
      bank_id: bankId,
      query,
      mode: "list",
      total: listed?.total ?? null,
      limit: listed?.limit ?? limit,
      offset: listed?.offset ?? 0,
      items,
    });
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
  const configPath = process.env.HINDSIGHT_CODING_AGENT_JSON || DEFAULT_CONFIG;
  let cfg = null;
  let access;
  try {
    cfg = loadCodingAgentConfig(configPath);
    access = resolveAccess(cfg);
  } catch (err) {
    // Stay alive so Cursor's MCP client does not report "Connection closed".
    // Tools return isError until coding-agent.json is readable.
    console.error(`notebooklm-mcp: cannot read ${configPath}: ${err instanceof Error ? err.message : err}`);
    access = { enabled: false, banks: ["*"], apiUrl: DEFAULT_API_URL };
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

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(thisFile)) {
  main().catch((err) => {
    console.error(`notebooklm-mcp: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
