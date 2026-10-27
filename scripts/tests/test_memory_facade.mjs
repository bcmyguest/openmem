#!/usr/bin/env node
import { callUnifiedTool } from "../../cli/mcp/memory-facade.mjs";

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok    ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

/** @param {{ content: { type: string, text: string }[], isError?: boolean }} r */
function parseText(r) {
  return JSON.parse(r.content[0].text);
}

/** @type {typeof fetch} */
function makeFetch(route) {
  return async (url, init) => {
    const hit = route(String(url), init);
    if (!hit) throw new Error(`unexpected fetch ${init?.method || "GET"} ${url}`);
    return hit;
  };
}

function okJson(body) {
  return {
    ok: true,
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}

const H_BASE = "http://127.0.0.1:8888";
const M_BASE = "http://127.0.0.1:18888";
const C_BASE = "http://127.0.0.1:8766";
const BANK = "test-bank";

/** @type {Array<{ id: string, ctx: Record<string, unknown>, tool: string, args: Record<string, unknown>, route: (u: string, init?: RequestInit) => ReturnType<typeof okJson>, expectCalls?: (calls: { url: string, init?: RequestInit }[]) => boolean, expectResult?: (r: ReturnType<typeof parseText>, raw: Awaited<ReturnType<typeof callUnifiedTool>>) => boolean }>} */
const HTTP_CASES = [
  {
    id: "hindsight/memory_add",
    ctx: { provider: "hindsight", hindsightUrl: H_BASE },
    tool: "memory_add",
    args: { content: "stored fact", bank: BANK },
    route(u, init) {
      if (u === `${H_BASE}/v1/default/banks/${encodeURIComponent(BANK)}/memories` && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        if (body.items?.[0]?.content === "stored fact" && body.async === true) {
          return okJson({ queued: 1 });
        }
      }
      return undefined;
    },
    expectResult(parsed) {
      return parsed.provider === "hindsight" && parsed.bank === BANK && parsed.result?.queued === 1;
    },
  },
  {
    id: "hindsight/memory_add_sync",
    ctx: { provider: "hindsight", hindsightUrl: H_BASE },
    tool: "memory_add",
    args: { content: "sync fact", bank: BANK, async: false },
    route(u, init) {
      if (u === `${H_BASE}/v1/default/banks/${encodeURIComponent(BANK)}/memories` && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        if (body.items?.[0]?.content === "sync fact" && body.async === false) {
          return okJson({ stored: 1 });
        }
      }
      return undefined;
    },
    expectResult(parsed) {
      return parsed.provider === "hindsight" && parsed.result?.stored === 1;
    },
  },
  {
    id: "hindsight/memory_search",
    ctx: { provider: "hindsight", hindsightUrl: H_BASE },
    tool: "memory_search",
    args: { query: "find me", bank: BANK },
    route(u, init) {
      if (u === `${H_BASE}/v1/default/banks/${encodeURIComponent(BANK)}/memories/recall` && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        if (body.query === "find me") return okJson({ items: [{ text: "hit" }] });
      }
      return undefined;
    },
    expectResult(parsed) {
      return parsed.provider === "hindsight" && parsed.query === "find me" && parsed.result?.items?.length === 1;
    },
  },
  {
    id: "mem0/memory_add",
    ctx: { provider: "mem0", mem0: { baseUrl: M_BASE, apiKey: "test-key" } },
    tool: "memory_add",
    args: { content: "mem0 line", bank: BANK },
    route(u, init) {
      if (u === `${M_BASE}/memories` && init?.method === "POST") {
        const headers = /** @type {Record<string, string>} */ (init.headers);
        const body = JSON.parse(String(init.body));
        if (
          headers["X-API-Key"] === "test-key" &&
          body.user_id === BANK &&
          body.infer === false &&
          body.messages?.[0]?.content === "mem0 line"
        ) {
          return okJson({ id: "m-new" });
        }
      }
      return undefined;
    },
    expectResult(parsed) {
      return parsed.provider === "mem0" && parsed.user_id === BANK && parsed.result?.id === "m-new";
    },
  },
  {
    id: "mem0/memory_search",
    ctx: { provider: "mem0", mem0: { baseUrl: M_BASE } },
    tool: "memory_search",
    args: { query: "widgets", bank: BANK, limit: 3 },
    route(u, init) {
      if (u === `${M_BASE}/search` && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        if (body.query === "widgets" && body.filters?.user_id === BANK && body.top_k === 3) {
          return okJson({ results: [{ memory: "widgets inc" }] });
        }
      }
      return undefined;
    },
    expectResult(parsed) {
      return parsed.provider === "mem0" && parsed.query === "widgets" && parsed.result?.results?.length === 1;
    },
  },
  {
    id: "cognee/memory_add",
    ctx: { provider: "cognee", cognee: { baseUrl: C_BASE, apiKey: "cg-key" } },
    tool: "memory_add",
    args: { content: "graph text", bank: BANK },
    route(u, init) {
      if (u === `${C_BASE}/api/v1/add` && init?.method === "POST") {
        const headers = /** @type {Record<string, string>} */ (init.headers);
        const body = JSON.parse(String(init.body));
        if (headers["X-Api-Key"] === "cg-key" && body.datasetName === BANK && body.data === "graph text") {
          return okJson({ status: "accepted" });
        }
      }
      return undefined;
    },
    expectResult(parsed) {
      return parsed.provider === "cognee" && parsed.dataset === BANK && parsed.result?.status === "accepted";
    },
  },
  {
    id: "cognee/memory_search",
    ctx: { provider: "cognee", cognee: { baseUrl: C_BASE } },
    tool: "memory_search",
    args: { query: "nodes", bank: BANK },
    route(u, init) {
      if (u === `${C_BASE}/api/v1/search` && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        if (body.query === "nodes" && body.searchType === "GRAPH_COMPLETION" && body.datasets?.[0] === BANK) {
          return okJson({ answer: "node hit" });
        }
      }
      return undefined;
    },
    expectResult(parsed) {
      return parsed.provider === "cognee" && parsed.query === "nodes" && parsed.result?.answer === "node hit";
    },
  },
];

for (const c of HTTP_CASES) {
  const raw = await callUnifiedTool(c.ctx, c.tool, c.args, makeFetch(c.route));
  check(`${c.id} not error`, !raw.isError);
  const parsed = parseText(raw);
  check(`${c.id} result shape`, c.expectResult?.(parsed, raw) ?? false);
}

/** @type {Array<{ id: string, ctx: Record<string, unknown>, expect: Record<string, unknown> }>} */
const STATUS_CASES = [
  {
    id: "hindsight",
    ctx: { provider: "hindsight", hindsightUrl: H_BASE },
    expect: { provider: "hindsight", hindsightUrl: H_BASE },
  },
  {
    id: "mem0",
    ctx: { provider: "mem0", mem0: { baseUrl: M_BASE, apiKey: "secret-not-in-status" } },
    expect: { provider: "mem0", mem0BaseUrl: M_BASE },
  },
  {
    id: "cognee",
    ctx: { provider: "cognee", cognee: { baseUrl: C_BASE, apiKey: "secret-not-in-status" } },
    expect: { provider: "cognee", cogneeBaseUrl: C_BASE },
  },
];

for (const c of STATUS_CASES) {
  let fetchCalls = 0;
  const raw = await callUnifiedTool(
    c.ctx,
    "memory_provider_status",
    {},
    async () => {
      fetchCalls++;
      return okJson({});
    },
  );
  check(`${c.id}/memory_provider_status no fetch`, fetchCalls === 0);
  check(`${c.id}/memory_provider_status not error`, !raw.isError);
  const parsed = parseText(raw);
  for (const [k, v] of Object.entries(c.expect)) {
    check(`${c.id}/memory_provider_status ${k}`, parsed[k] === v);
  }
  check(`${c.id}/memory_provider_status no api key`, !raw.content[0].text.includes("secret-not-in-status"));
}

if (failed) process.exit(1);
console.log("all memory facade tests passed");
