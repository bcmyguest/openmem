#!/usr/bin/env node
import { callUnifiedTool, UNIFIED_MCP_TOOLS } from "../../cli/mcp/memory-facade.mjs";
import { initiativeTrigger } from "../../cli/mcp/knowledge.mjs";

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok    ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

const H_BASE = "http://127.0.0.1:8888";
const BANK = "coding-agent::demo";
const BANK_URL = `${H_BASE}/v1/default/banks/${encodeURIComponent(BANK)}`;
const HS = { provider: "hindsight", hindsightUrl: H_BASE };

function res(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return body === undefined ? "" : JSON.stringify(body);
    },
  };
}

/** Records every call; `route` returns a response or undefined (unexpected call). */
function recorder(route) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || "GET", body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const hit = route(call);
    if (!hit) throw new Error(`unexpected fetch ${call.method} ${call.url}`);
    return hit;
  };
  return { calls, fetchFn };
}

async function run(ctx, tool, args, route) {
  const rec = recorder(route);
  const raw = await callUnifiedTool(ctx, tool, args, rec.fetchFn);
  let parsed;
  try {
    parsed = JSON.parse(raw.content[0].text);
  } catch {
    parsed = raw.content[0].text;
  }
  return { raw, parsed, calls: rec.calls };
}

const names = UNIFIED_MCP_TOOLS.map((t) => t.name);
for (const n of ["memory_pages_list", "memory_pages_search", "memory_pages_read", "memory_capture_initiative", "memory_status"]) {
  check(`tools/list includes ${n}`, names.includes(n));
}

{
  const tree = {
    roots: [
      { id: "kp-1", kind: "page", name: "Component map", description: "q1" },
      { id: "f-1", kind: "folder", name: "Initiatives", children: [{ id: "kp-2", kind: "page", name: "Proxy" }] },
    ],
  };
  const { raw, parsed } = await run(HS, "memory_pages_list", { bank: BANK }, (c) =>
    c.url === `${BANK_URL}/knowledge-base/tree` ? res(200, tree) : undefined,
  );
  check("pages_list not error", !raw.isError, raw.content[0].text);
  check(
    "pages_list flattens pages and keeps folder",
    parsed.pages?.length === 2 && parsed.pages[0].description === "q1" && parsed.pages[1].folder === "Initiatives",
    JSON.stringify(parsed),
  );
}

{
  const { parsed } = await run(HS, "memory_pages_list", { bank: BANK }, () => res(404, { detail: "Bank not found" }));
  check("pages_list on missing bank returns no pages", Array.isArray(parsed.pages) && parsed.pages.length === 0);
}

{
  const { parsed, calls } = await run(HS, "memory_pages_search", { bank: BANK, query: "why proxy", limit: 3 }, (c) =>
    c.url.startsWith(`${BANK_URL}/knowledge-base/search?`)
      ? res(200, { results: [{ id: "kp-2", name: "Proxy", snippet: "because", score: 0.7, extra: 1 }] })
      : undefined,
  );
  check("pages_search sends q and limit", calls[0]?.url === `${BANK_URL}/knowledge-base/search?q=why%20proxy&limit=3`, calls[0]?.url);
  check("pages_search maps hits", parsed.hits?.[0]?.id === "kp-2" && parsed.hits[0].snippet === "because" && !("extra" in parsed.hits[0]));
}

{
  const { raw } = await run(HS, "memory_pages_search", { bank: BANK }, () => undefined);
  check("pages_search without query is an error", raw.isError === true);
}

{
  const { parsed } = await run(HS, "memory_pages_read", { bank: BANK, page_id: "kp-2" }, (c) =>
    c.url === `${BANK_URL}/knowledge-base/pages/kp-2` ? res(200, { id: "kp-2", name: "Proxy", body: "  ", markdown: "# md body" }) : undefined,
  );
  check("pages_read falls back to markdown when body is blank", parsed.page?.body === "# md body", JSON.stringify(parsed));
}

{
  const { raw } = await run(HS, "memory_pages_read", { bank: BANK, page_id: "kp-x" }, () => res(404, { detail: "not found" }));
  check("pages_read 404 is an error naming the page", raw.isError === true && raw.content[0].text.includes("kp-x"));
}

{
  const { parsed, calls } = await run(
    HS,
    "memory_capture_initiative",
    { bank: BANK, title: "Context proxy", summary: "Trim old turns." },
    (c) => {
      if (c.url === `${BANK_URL}/knowledge-base/tree`) return res(200, { roots: [] });
      if (c.url === `${BANK_URL}/knowledge-base/folders` && c.method === "POST") return res(200, { id: "f-9" });
      if (c.url === `${BANK_URL}/knowledge-base/pages` && c.method === "POST") return res(200, { page_id: "kp-new", operation_id: "op-p" });
      if (c.url === `${BANK_URL}/memories` && c.method === "POST") return res(200, { success: true, operation_id: "op-m" });
      return undefined;
    },
  );
  const page = calls.find((c) => c.url.endsWith("/knowledge-base/pages"))?.body;
  const marker = calls.find((c) => c.url.endsWith("/memories"))?.body;
  check("capture creates the Initiatives folder", calls.some((c) => c.url.endsWith("/knowledge-base/folders") && c.body?.name === "Initiatives"));
  check(
    "capture creates the page under the folder with scope and trigger",
    page?.parent_id === "f-9" && page.name === "Context proxy" && page.source_query.includes("Scope this page to demo ITSELF") &&
      JSON.stringify(page.trigger) === JSON.stringify(initiativeTrigger(BANK, "Context proxy")),
    JSON.stringify(page),
  );
  check(
    "capture retains a marker linked to the page",
    marker?.async === true && marker.items[0].context === "initiative marker for [[page:kp-new]]" &&
      marker.items[0].document_id === "initiative-marker-kp-new" && marker.items[0].content.startsWith("New initiative: Context proxy."),
    JSON.stringify(marker),
  );
  check("capture returns page and marker op", parsed.page_id === "kp-new" && parsed.operation_id === "op-m" && parsed.updated === false);
}

{
  const { parsed, calls } = await run(
    HS,
    "memory_capture_initiative",
    { bank: BANK, title: "Context proxy", summary: "Added rtk.", relates_to_page_id: "kp-new" },
    (c) => (c.url === `${BANK_URL}/memories` && c.method === "POST" ? res(200, { operation_id: "op-u" }) : undefined),
  );
  check("capture update makes no page", calls.length === 1);
  check(
    "capture update marker uses -update document id",
    calls[0].body.items[0].document_id === "initiative-marker-kp-new-update" && calls[0].body.items[0].content.startsWith("Update to an existing initiative"),
  );
  check("capture update reports updated", parsed.updated === true && parsed.page_id === "kp-new");
}

{
  const counts = { pending: 2, processing: 1, failed: 5 };
  const { parsed } = await run(HS, "memory_status", { bank: BANK }, (c) => {
    const m = /\/operations\?status=(\w+)&limit=1$/.exec(c.url);
    return m ? res(200, { total: counts[m[1]], operations: [] }) : undefined;
  });
  check("status counts active and failed", parsed.active === 3 && parsed.failed === 5 && parsed.ready === false, JSON.stringify(parsed));
}

{
  const opStatus = { "op-a": "completed", "op-b": "failed" };
  const { parsed } = await run(HS, "memory_status", { bank: BANK, operation_ids: ["op-a", "op-b"] }, (c) => {
    if (/\/operations\?status=/.test(c.url)) return res(200, { total: 0 });
    const m = /\/operations\/([\w-]+)$/.exec(c.url);
    return m ? res(200, { operation_id: m[1], status: opStatus[m[1]].toUpperCase() }) : undefined;
  });
  check("status: terminal ops are ready", parsed.ready === true);
  check("status: a failed op is not ingested", parsed.ingested === false && parsed.operations["op-b"] === "failed");
}

{
  const { parsed } = await run(HS, "memory_status", { bank: BANK, operation_ids: ["op-gone"] }, (c) => {
    if (/\/operations\?status=/.test(c.url)) return res(200, { total: 0 });
    return /\/operations\/op-gone$/.test(c.url) ? res(404, { detail: "not found" }) : undefined;
  });
  check("status: an unknown op is neither ready nor ingested", parsed.ready === false && parsed.ingested === false);
}

{
  const { parsed, calls } = await run({ provider: "mem0", mem0: { baseUrl: "http://m" } }, "memory_status", {}, () => undefined);
  check("mem0 status is ready without HTTP", parsed.ready === true && calls.length === 0);
}

for (const [provider, ctx] of [
  ["mem0", { provider: "mem0", mem0: { baseUrl: "http://m" } }],
  ["cognee", { provider: "cognee", cognee: { baseUrl: "http://c" } }],
]) {
  const { raw, parsed, calls } = await run(ctx, "memory_pages_search", { query: "x" }, () => undefined);
  check(`${provider} pages_search is unsupported, not an error`, !raw.isError && parsed.supported === false && calls.length === 0);
}

{
  const { parsed } = await run({ provider: "cognee", cognee: { baseUrl: "http://c" } }, "memory_status", {}, () => undefined);
  check("cognee status is unsupported", parsed.supported === false);
}

if (failed) process.exit(1);
console.log("all knowledge tool tests passed");
