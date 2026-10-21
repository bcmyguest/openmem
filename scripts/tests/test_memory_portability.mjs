#!/usr/bin/env node
import { assertPmmVersion, buildPmm, memoryImport, parsePmm, memoryExport } from "../../cli/mcp/portability.mjs";
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
          return JSON.stringify([{ id: "d1", name: "doc.md", label: "hello cognee", externalMetadata: { doc_id: "x" } }]);
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
  check("cognee export records", out.records.length === 1 && out.records[0].content === "hello cognee");
}

if (failed) process.exit(1);
console.log("all memory portability tests passed");
