#!/usr/bin/env node
import { buildPmm, parsePmm, memoryExport } from "../../cli/mcp/portability.mjs";

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

if (failed) process.exit(1);
console.log("all memory portability tests passed");
