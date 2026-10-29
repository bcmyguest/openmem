/**
 * Provider-neutral knowledge tools: pages, initiatives, ingest status.
 * Hindsight is the reference implementation (knowledge-base + operations API); other providers
 * answer "unsupported" from PROVIDER_CAPABILITIES so prompts keep working across `switch`.
 */

import { providerSupports } from "../coding-agent/capabilities.mjs";

const DEFAULT_BANK = "openmem-mcp";
const PAGE_MAX_TOKENS = 4096;
const PAGE_SEARCH_LIMIT = 5;
const INITIATIVES_FOLDER = "Initiatives";
const INITIATIVE_TAG = "knowledge:feature-work";
const ACTIVE_STATUSES = ["pending", "processing"];
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "error"]);
const CODING_AGENT_PREFIX = "coding-agent::";

const BANK_PROP = {
  type: "string",
  description: "Hindsight bank (use memory_project_scope for the project bank; default openmem-mcp)",
};

export const KNOWLEDGE_MCP_TOOLS = [
  {
    name: "memory_pages_list",
    title: "List knowledge pages",
    description:
      "List the curated knowledge pages of a bank (ids, names, folders; no page bodies). " +
      "Use to see which architecture, convention, decision, and initiative pages exist before reading one. " +
      "Hindsight only; other providers return supported: false. Read-only.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: { type: "object", properties: { bank: BANK_PROP }, additionalProperties: false },
  },
  {
    name: "memory_pages_search",
    title: "Search knowledge pages",
    description:
      "Search a bank's knowledge pages (hybrid keyword + vector) and return page hits with a relevance snippet. " +
      "First stop before fixing a bug, changing a test, or implementing something new: pages hold past decisions and conventions. " +
      "Pages are a past record; check claims against the code. Hindsight only; other providers return supported: false. Read-only.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you need to know" },
        bank: BANK_PROP,
        limit: { type: "number", description: "Max page hits (default 5)" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_pages_read",
    title: "Read a knowledge page",
    description:
      "Read one knowledge page's synthesized body by id (from memory_pages_list, memory_pages_search, or a [[page:<id>]] link). " +
      "Hindsight only; other providers return supported: false. Read-only.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        page_id: { type: "string", description: "Knowledge page id (kp-…)" },
        bank: BANK_PROP,
      },
      required: ["page_id"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_capture_initiative",
    title: "Capture an initiative",
    description:
      "Record a new feature or initiative as a tracked knowledge page plus a marker memory, right after the user approves a plan " +
      "and before writing code. Pass relates_to_page_id to record a material plan change on an existing initiative instead of a new page. " +
      "Skip bug fixes and small tweaks. Hindsight only; other providers return supported: false.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short, specific initiative name (reuse it on updates)" },
        summary: { type: "string", description: "Two or three sentences: what is being built and why, current intent" },
        relates_to_page_id: { type: "string", description: "Existing initiative page id when recording a change" },
        bank: BANK_PROP,
      },
      required: ["title", "summary"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_status",
    title: "Ingest status",
    description:
      "Report whether a bank's async ingest has drained: active (pending/processing) and failed operation counts, " +
      "and the status of specific operation ids returned by memory_add. ready is true when nothing requested is still active. " +
      "Use before relying on recall for just-stored content. mem0 ingest is synchronous (always ready); Cognee returns supported: false. Read-only.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        bank: BANK_PROP,
        operation_ids: { type: "array", items: { type: "string" }, description: "Operation ids to check" },
      },
      additionalProperties: false,
    },
  },
];

export const KNOWLEDGE_TOOL_NAMES = new Set(KNOWLEDGE_MCP_TOOLS.map((t) => t.name));

const TOOL_FEATURE = {
  memory_pages_list: "knowledge_pages",
  memory_pages_search: "knowledge_pages",
  memory_pages_read: "knowledge_pages",
  memory_capture_initiative: "initiatives",
  memory_status: "ingest_status",
};

/** Scope clause appended to a page's source query (Hindsight coding-agent wording). */
export function pageScopeRule(project) {
  return (
    ` Scope this page to ${project} ITSELF: the bank also holds facts about external tools, libraries and services that ${project} ` +
    `merely uses, configures, deploys or discusses, and those belong to somebody else's codebase. Include something only when its ` +
    `subject is ${project}'s own code, configuration or process; when it is about a dependency, leave it out however well-evidenced it ` +
    `looks — including any commit SHA or identifier that belongs to that dependency's repository rather than this one.`
  );
}

/** Hourly refresh at a minute derived from bank + page name, so pages do not all refresh at once. */
export function initiativeTrigger(bank, name) {
  let h = 0;
  for (const ch of `${bank}\0${name}`) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return { fact_types: ["world", "experience", "observation"], tags_match: "all", refresh_cron: `${h % 60} * * * *` };
}

export function slugify(s) {
  return (
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "initiative"
  );
}

function projectOf(bank) {
  return bank.startsWith(CODING_AGENT_PREFIX) ? bank.slice(CODING_AGENT_PREFIX.length) : bank;
}

function unsupported(provider, name) {
  return { provider, supported: false, tool: name, reason: `${provider} has no ${TOOL_FEATURE[name]} support in OpenMem` };
}

/**
 * @param {string} url
 * @param {RequestInit} init
 * @param {typeof fetch} fetchFn
 * @param {number[]} [allow] non-2xx statuses returned as { status } instead of thrown
 */
async function hsJson(url, init, fetchFn, allow = []) {
  const res = await fetchFn(url, init);
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok) {
    if (allow.includes(res.status)) return { status: res.status, json };
    throw new Error(`${init.method || "GET"} ${url} → ${res.status}: ${String(typeof json === "string" ? json : JSON.stringify(json)).slice(0, 400)}`);
  }
  return { status: res.status ?? 200, json };
}

function flattenPages(nodes, folder, out = []) {
  for (const n of nodes || []) {
    if (!n?.id || !n?.name) continue;
    if (n.kind === "page") {
      out.push({ id: n.id, name: n.name, ...(n.description ? { description: n.description } : {}), ...(folder ? { folder } : {}) });
    }
    if (n.children?.length) flattenPages(n.children, n.kind === "folder" ? n.name : folder, out);
  }
  return out;
}

async function ensureFolder(bankUrl, name, fetchFn) {
  const tree = await hsJson(`${bankUrl}/knowledge-base/tree`, { method: "GET" }, fetchFn);
  const hit = (tree.json?.roots || []).find((n) => n.kind === "folder" && String(n.name || "").toLowerCase() === name.toLowerCase());
  if (hit?.id) return hit.id;
  const created = await hsJson(
    `${bankUrl}/knowledge-base/folders`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) },
    fetchFn,
  );
  return created.json?.id;
}

async function countOps(bankUrl, status, fetchFn) {
  const r = await hsJson(`${bankUrl}/operations?status=${status}&limit=1`, { method: "GET" }, fetchFn);
  return Number(r.json?.total ?? r.json?.operations?.length ?? 0);
}

/**
 * @param {ReturnType<import("./context.mjs").resolveMcpContext>} ctx
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {typeof fetch} fetchFn
 */
export async function callKnowledgeTool(ctx, name, args, fetchFn) {
  if (ctx.provider === "mem0" && name === "memory_status") {
    return { provider: "mem0", supported: true, ready: true, note: "mem0 ingest is synchronous (infer: false)" };
  }
  if (!providerSupports(ctx.provider, TOOL_FEATURE[name])) return unsupported(ctx.provider, name);
  if (!ctx.hindsightUrl) throw new Error("Hindsight API URL not configured");

  const bank = String(args.bank || DEFAULT_BANK).trim() || DEFAULT_BANK;
  const bankUrl = `${ctx.hindsightUrl}/v1/default/banks/${encodeURIComponent(bank)}`;

  if (name === "memory_pages_list") {
    const r = await hsJson(`${bankUrl}/knowledge-base/tree`, { method: "GET" }, fetchFn, [404]);
    return { provider: "hindsight", bank, pages: r.status === 404 ? [] : flattenPages(r.json?.roots) };
  }
  if (name === "memory_pages_search") {
    const query = String(args.query || "").trim();
    if (!query) throw new Error("query is required");
    const limit = Number(args.limit) > 0 ? Number(args.limit) : PAGE_SEARCH_LIMIT;
    const r = await hsJson(
      `${bankUrl}/knowledge-base/search?q=${encodeURIComponent(query)}&limit=${limit}`,
      { method: "GET" },
      fetchFn,
      [404],
    );
    const hits = r.status === 404 ? [] : (r.json?.results || []).map((x) => ({
      id: x.id,
      name: x.name,
      snippet: x.snippet ?? "",
      score: x.score ?? 0,
    }));
    return { provider: "hindsight", bank, query, hits };
  }
  if (name === "memory_pages_read") {
    const pageId = String(args.page_id || "").trim();
    if (!pageId) throw new Error("page_id is required");
    const r = await hsJson(`${bankUrl}/knowledge-base/pages/${encodeURIComponent(pageId)}`, { method: "GET" }, fetchFn, [404]);
    if (r.status === 404) throw new Error(`knowledge page not found: ${pageId}`);
    const p = r.json || {};
    const body = typeof p.body === "string" && p.body.trim() ? p.body : p.markdown;
    return {
      provider: "hindsight",
      bank,
      page: { id: p.id, name: p.name, ...(p.tags?.length ? { tags: p.tags } : {}), ...(p.timestamp ? { last_updated_at: p.timestamp } : {}), body },
    };
  }
  if (name === "memory_capture_initiative") {
    const title = String(args.title || "").trim();
    const summary = String(args.summary || "").trim();
    if (!title || !summary) throw new Error("title and summary are required");
    const relatesTo = String(args.relates_to_page_id || "").trim();
    let pageId = relatesTo;
    if (!pageId) {
      const folderId = await ensureFolder(bankUrl, INITIATIVES_FOLDER, fetchFn);
      const r = await hsJson(
        `${bankUrl}/knowledge-base/pages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: title,
            source_query:
              `Summarize the "${title}" initiative: what is being built or changed and why, and its current state — drawn from the project's memory.` +
              pageScopeRule(projectOf(bank)),
            ...(folderId ? { parent_id: folderId } : {}),
            tags: [INITIATIVE_TAG],
            max_tokens: PAGE_MAX_TOKENS,
            trigger: initiativeTrigger(bank, title),
          }),
        },
        fetchFn,
      );
      pageId = r.json?.page_id || r.json?.id || `initiative-${slugify(title)}`;
    }
    const verb = relatesTo ? "Update to an existing initiative" : "New initiative";
    const retained = await hsJson(
      `${bankUrl}/memories`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          async: true,
          items: [
            {
              content: `${verb}: ${title}. ${summary}`,
              context: `initiative marker for [[page:${pageId}]]`,
              document_id: `initiative-marker-${slugify(pageId)}${relatesTo ? "-update" : ""}`,
              tags: [INITIATIVE_TAG],
              metadata: { relatedPageId: pageId },
            },
          ],
        }),
      },
      fetchFn,
    );
    return { provider: "hindsight", bank, page_id: pageId, updated: Boolean(relatesTo), operation_id: retained.json?.operation_id ?? null };
  }
  if (name === "memory_status") {
    const [pending, processing, failed] = await Promise.all(
      [...ACTIVE_STATUSES, "failed"].map((s) => countOps(bankUrl, s, fetchFn)),
    );
    const ids = Array.isArray(args.operation_ids) ? args.operation_ids.map(String).filter(Boolean) : [];
    const operations = {};
    for (const id of ids) {
      const r = await hsJson(`${bankUrl}/operations/${encodeURIComponent(id)}`, { method: "GET" }, fetchFn, [404]);
      operations[id] = r.status === 404 ? "not_found" : String(r.json?.status || "unknown").toLowerCase();
    }
    const statuses = Object.values(operations);
    return {
      provider: "hindsight",
      bank,
      supported: true,
      active: pending + processing,
      pending,
      processing,
      failed,
      ...(ids.length
        ? {
            operations,
            // ingested: every requested op completed; a failed or unknown op is never counted as stored.
            ingested: statuses.every((s) => s === "completed"),
          }
        : {}),
      ready: ids.length ? statuses.every((s) => TERMINAL_STATUSES.has(s)) : pending + processing === 0,
    };
  }
  throw new Error(`unknown tool: ${name}`);
}
