#!/usr/bin/env node
import { assertPmmVersion, buildPmm, memoryImport, parsePmm, memoryExport, serializePmm } from "../../cli/mcp/portability.mjs";
import { callUnifiedTool, textResult } from "../../cli/mcp/memory-facade.mjs";
import { hindsightRecordMetadata } from "../../cli/mcp/export/hindsight.mjs";
import { sortPmmRecords } from "../../cli/mcp/pmm-records.mjs";
import { cogneeDatasetName } from "../../cli/mcp/export/cognee-dataset-name.mjs";

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok    ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

{
  const pmm = buildPmm({ provider: "mem0", scope: { user_id: "u" }, records: [{ content: "x" }] });
  check("pmm version", pmm.pmm_version === 1);
  const round = parsePmm(JSON.stringify(pmm));
  check("parse json", round.pmm.source_provider === "mem0");
}

{
  const sorted = sortPmmRecords([
    { scope_key: "b", id: "2", content: "z" },
    { scope_key: "a", content: "y" },
    { scope_key: "b", id: "1", content: "a" },
  ]);
  check("record sort order", sorted[0].scope_key === "a" && sorted[2].content === "z");
  let threw = false;
  try {
    assertPmmVersion(2);
  } catch {
    threw = true;
  }
  check("reject pmm major 2", threw);
}

{
  const pmm = buildPmm({
    provider: "mem0",
    scope: { user_id: "u" },
    records: [{ id: "1", content: "hello", scope_key: "u" }, { content: "new", scope_key: "u" }],
  });
  /** @type {typeof fetch} */
  const fetchFn = async (url, init) => {
    const u = String(url);
    if (u.includes("/memories?") && (!init || !init.method)) {
      return {
        ok: true,
        async text() {
          return JSON.stringify([{ id: "1", memory: "hello" }]);
        },
      };
    }
    if (u.endsWith("/memories") && init?.method === "POST") {
      return { ok: true, async text() { return "{}"; } };
    }
    throw new Error(`unexpected ${u}`);
  };
  let addCalls = 0;
  const addFn = async () => {
    addCalls++;
  };
  const summary = await memoryImport(
    { provider: "mem0", mem0: { baseUrl: "http://127.0.0.1:1" } },
    JSON.stringify(pmm),
    { merge_strategy: "skip_duplicates" },
    fetchFn,
    addFn,
  );
  check("mem0 dedupe skips hello", summary.skipped_count === 1 && summary.imported_count === 1);
  check("mem0 dedupe one add", addCalls === 1);
}

{
  const fetchFn = async () => ({
    ok: true,
    async text() {
      return JSON.stringify({ results: [{ id: "1", memory: "hello" }] });
    },
  });
  const out = await memoryExport(
    { provider: "mem0", mem0: { baseUrl: "http://127.0.0.1:1", apiKey: "k" } },
    { bank: "u" },
    fetchFn,
  );
  check("mem0 export records", out.records.length === 1);
}

{
  check("cognee dataset name stable", cogneeDatasetName("coding-agent::demo") === cogneeDatasetName("coding-agent::demo"));
  const ds = cogneeDatasetName("obsidian::notes");
  check("cognee dataset slug", /^[a-z0-9_]+$/.test(ds));
}

{
  const banks = { banks: [{ bank_id: "coding-agent::a", fact_count: 1 }] };
  /** @type {typeof fetch} */
  const fetchFn = async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/default/banks")) {
      return { ok: true, async json() { return banks; }, async text() { return JSON.stringify(banks); } };
    }
    if (u.includes("/memories/list?")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            items: [{ id: "m1", text: "fact one" }],
            total: 1,
            limit: 500,
            offset: 0,
          });
        },
      };
    }
    throw new Error(`unexpected ${u}`);
  };
  const out = await memoryExport({ provider: "hindsight", hindsightUrl: "http://127.0.0.1:8888" }, {}, fetchFn);
  check("hindsight export records", out.records.length === 1 && out.records[0].scope_key === "coding-agent::a");
}

{
  const bank = "obsidian::vault";
  const datasetName = cogneeDatasetName(bank);
  const datasetId = "00000000-0000-0000-0000-000000000001";
  /** @type {typeof fetch} */
  const fetchFn = async (url) => {
    const u = String(url);
    if (u.endsWith("/api/v1/datasets")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify([{ id: datasetId, name: datasetName }]);
        },
      };
    }
    if (u.includes(`/datasets/${datasetId}/data`)) {
      return {
        ok: true,
        async text() {
          return JSON.stringify([
            { id: "d1", name: "doc.md", label: "hello cognee", externalMetadata: { doc_id: "x" } },
            {
              id: "d2",
              name: "full.md",
              label: "short label",
              text: "full document body from text field",
              externalMetadata: { doc_id: "y" },
            },
          ]);
        },
      };
    }
    throw new Error(`unexpected ${u}`);
  };
  const out = await memoryExport(
    { provider: "cognee", cognee: { baseUrl: "http://127.0.0.1:8766" } },
    { bank },
    fetchFn,
  );
  check(
    "cognee export records",
    out.records.length === 2
      && out.records.find((r) => r.id === "d1")?.content === "hello cognee"
      && out.records.find((r) => r.id === "d2")?.content === "full document body from text field",
  );
}

// --- JSON / JSONL round trips -------------------------------------------------------------
{
  const recs = [
    { id: "a", content: "hello", scope_key: "demo", metadata: { source: "notes.md" } },
    { id: "b", content: "world", scope_key: "demo" },
  ];
  for (const records of [[], recs.slice(0, 1), recs]) {
    const pmm = buildPmm({ provider: "mem0", scope: { user_id: "demo" }, records });
    const viaJsonl = parsePmm(serializePmm(pmm, "jsonl")).pmm;
    const viaJson = parsePmm(JSON.stringify(serializePmm(pmm, "json"))).pmm;
    for (const [fmt, got] of [["jsonl", viaJsonl], ["json", viaJson]]) {
      check(
        `${fmt} round trip, ${records.length} records`,
        got.source_provider === "mem0"
          && got.scope.user_id === "demo"
          && JSON.stringify(got.records) === JSON.stringify(pmm.records),
        JSON.stringify(got.records),
      );
    }
  }
  const throws = (data, re) => {
    try {
      parsePmm(data);
      return false;
    } catch (err) {
      return re.test(String(err.message));
    }
  };
  const header = JSON.stringify({ pmm_version: 1, source_provider: "mem0", scope: {} });
  check("malformed json rejected", throws('{"pmm_version": 1,', /not valid JSON/));
  check("malformed jsonl line names its line", throws(`${header}\n{"content": "x"\n`, /line 2/));
  check("jsonl record before header rejected", throws(`{"content": "x"}\n${header}\n`, /header/));
  check("jsonl second header rejected", throws(`${header}\n${header}\n`, /second PMM header/));
  check("jsonl non-object line rejected", throws(`${header}\n[1]\n`, /line 2: expected a JSON object/));
  check("jsonl wrong major rejected", throws(`${header.replace('"pmm_version":1', '"pmm_version":2')}\n{"content":"x"}\n`, /major/));
}

// --- import surfaces failed writes ------------------------------------------------------------
{
  const pmm = buildPmm({
    provider: "hindsight",
    scope: { bank: "b" },
    records: [
      { id: "1", content: "ok", scope_key: "b" },
      { id: "2", content: "rejected", scope_key: "b" },
      { id: "3", content: "throws", scope_key: "b" },
    ],
  });
  const addFn = async (_ctx, _name, args) => {
    if (args.content === "rejected") return textResult("backend said no", true);
    if (args.content === "throws") throw new Error("socket closed");
    return textResult({ provider: "hindsight", metadata_lossy: { stringified: [], dropped: [] } });
  };
  const s = await memoryImport({ provider: "hindsight" }, JSON.stringify(pmm), {}, fetch, addFn);
  check("partial import counts only successes", s.imported_count === 1 && s.failed_count === 2, JSON.stringify(s));
  check("partial import status", s.status === "partial");
  check(
    "failed records carry their errors",
    s.failed.some((f) => f.id === "2" && /backend said no/.test(f.error))
      && s.failed.some((f) => f.id === "3" && /socket closed/.test(f.error)),
    JSON.stringify(s.failed),
  );
}

{
  // The original report: Hindsight import with no URL configured claimed success.
  const pmm = buildPmm({ provider: "mem0", scope: { user_id: "u" }, records: [{ id: "1", content: "x", scope_key: "u" }] });
  const res = await callUnifiedTool({ provider: "hindsight" }, "memory_import", { data: JSON.stringify(pmm) });
  const s = JSON.parse(res.content[0].text);
  check("import with no backend is an error", res.isError === true && s.imported_count === 0 && s.failed_count === 1, res.content[0].text);
  check("import with no backend status failed", s.status === "failed" && /not configured/.test(s.failed[0].error));
  const bad = await callUnifiedTool({ provider: "hindsight" }, "memory_import", { data: "{nope" });
  check("unparsable import is an error result", bad.isError === true && /not valid JSON/.test(bad.content[0].text));
}

// --- metadata survives import ----------------------------------------------------------------
const richRecord = {
  id: "src-42",
  content: "The deploy key moved to vault",
  scope_key: "coding-agent::demo",
  metadata: {
    source: "docs/ops.md#keys",
    timestamp: "2026-03-01T12:00:00Z",
    supersedes: ["src-17"],
    state: "valid",
    invalidation_reason: null,
  },
};
const richPmm = JSON.stringify(buildPmm({ provider: "hindsight", scope: { bank: "coding-agent::demo" }, records: [richRecord] }));

/** fetch stub that records POST bodies and answers a write endpoint with {}. */
function capture(match) {
  const bodies = [];
  const fetchFn = async (url, init) => {
    const u = String(url);
    if (init?.method === "POST" && match(u)) {
      bodies.push(JSON.parse(init.body));
      return { ok: true, async text() { return "{}"; } };
    }
    if (u.includes("/memories?")) return { ok: true, async text() { return "[]"; } };
    throw new Error(`unexpected ${u}`);
  };
  return { bodies, fetchFn };
}

{
  const { bodies, fetchFn } = capture((u) => u.endsWith("/memories"));
  const res = await callUnifiedTool({ provider: "hindsight", hindsightUrl: "http://h" }, "memory_import", { data: richPmm }, fetchFn);
  const item = bodies[0]?.items?.[0] || {};
  const m = item.metadata || {};
  check("hindsight import ok", res.isError === false, res.content[0].text);
  check(
    "hindsight keeps source, timestamp and supersession",
    m.source === "docs/ops.md#keys" && m.timestamp === "2026-03-01T12:00:00Z"
      && m.supersedes === '["src-17"]' && m.state === "valid" && item.timestamp === "2026-03-01T12:00:00Z",
    JSON.stringify(item),
  );
  check("hindsight keeps provenance", m.pmm_source_id === "src-42" && m.pmm_source_provider === "hindsight");
  const s = JSON.parse(res.content[0].text);
  check(
    "hindsight lossy report",
    s.metadata_lossy.supersedes?.stringified === 1 && s.metadata_lossy.invalidation_reason?.dropped === 1,
    JSON.stringify(s.metadata_lossy),
  );
}

{
  const { bodies, fetchFn } = capture((u) => u.endsWith("/memories"));
  const res = await callUnifiedTool(
    { provider: "mem0", mem0: { baseUrl: "http://m" } },
    "memory_import",
    { data: richPmm, merge_strategy: "overwrite" },
    fetchFn,
  );
  const m = bodies[0]?.metadata || {};
  check("mem0 import ok", res.isError === false, res.content[0].text);
  check(
    "mem0 keeps metadata verbatim",
    m.source === "docs/ops.md#keys" && m.timestamp === "2026-03-01T12:00:00Z"
      && Array.isArray(m.supersedes) && m.supersedes[0] === "src-17" && m.pmm_source_id === "src-42",
    JSON.stringify(bodies[0]),
  );
  check("mem0 reports nothing lossy", Object.keys(JSON.parse(res.content[0].text).metadata_lossy).length === 0);
}

{
  const { bodies, fetchFn } = capture((u) => u.endsWith("/api/v1/add"));
  const res = await callUnifiedTool({ provider: "cognee", cognee: { baseUrl: "http://c" } }, "memory_import", { data: richPmm }, fetchFn);
  const s = JSON.parse(res.content[0].text);
  check("cognee import ok", res.isError === false && bodies.length === 1, res.content[0].text);
  check("cognee reports dropped metadata", s.metadata_lossy.source?.dropped === 1 && s.metadata_lossy.pmm_source_id?.dropped === 1);
}

{
  const res = await callUnifiedTool({ provider: "mem0", mem0: { baseUrl: "http://m" } }, "memory_add", { content: "x", metadata: "nope" });
  check("memory_add rejects non-object metadata", res.isError === true);
}

{
  const m = hindsightRecordMetadata({
    id: "x", text: "t", fact_type: "world", date: "2026-01-01T00:00:00Z", context: "", tags: [],
    state: "invalidated", invalidation_reason: "superseded", invalidated_at: "2026-02-01T00:00:00Z",
    source_memory_ids: ["y"], document_id: null, metadata: { origin: "chat" },
  });
  check(
    "hindsight export keeps timestamps and supersession",
    m.type === "world" && m.fact_type === "world" && m.date === "2026-01-01T00:00:00Z" && m.state === "invalidated"
      && m.invalidation_reason === "superseded" && m.source_memory_ids[0] === "y" && m.origin === "chat"
      && !("context" in m) && !("tags" in m) && !("document_id" in m),
    JSON.stringify(m),
  );
}

if (failed) process.exit(1);
console.log("all memory portability tests passed");
