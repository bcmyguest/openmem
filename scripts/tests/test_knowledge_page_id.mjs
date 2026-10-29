#!/usr/bin/env node
// memory_capture_initiative errors when Hindsight returns no page id instead of inventing one.
import { callUnifiedTool } from "../../cli/mcp/memory-facade.mjs";

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

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });

for (const [label, pageBody] of [
  ["empty object", {}],
  ["blank page_id", { page_id: "  ", operation_id: "op-p" }],
  ["null body", null],
]) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET" });
    if (url === `${BANK_URL}/knowledge-base/tree`) return res(200, { roots: [{ kind: "folder", id: "f-1", name: "Initiatives" }] });
    if (url === `${BANK_URL}/knowledge-base/pages` && init.method === "POST") return res(200, pageBody);
    if (url === `${BANK_URL}/memories`) return res(200, { operation_id: "op-m" });
    throw new Error(`unexpected fetch ${url}`);
  };
  const out = await callUnifiedTool({ provider: "hindsight", hindsightUrl: H_BASE }, "memory_capture_initiative", { bank: BANK, title: "Ctx", summary: "S." }, fetchFn);
  check(`${label}: returns an error result`, out.isError === true && /no page id/.test(out.content[0].text), out.content[0].text);
  check(`${label}: retains no marker`, !calls.some((c) => c.url.endsWith("/memories")), JSON.stringify(calls));
  check(`${label}: invents no initiative-<slug> id`, !out.content[0].text.includes("initiative-ctx"));
}

{
  const fetchFn = async (url, init = {}) => {
    if (url === `${BANK_URL}/knowledge-base/tree`) return res(200, { roots: [] });
    if (url === `${BANK_URL}/knowledge-base/folders`) return res(200, { id: "f-2" });
    if (url === `${BANK_URL}/knowledge-base/pages` && init.method === "POST") return res(200, { id: "kp-alt" });
    if (url === `${BANK_URL}/memories`) return res(200, { operation_id: "op-m" });
    throw new Error(`unexpected fetch ${url}`);
  };
  const out = await callUnifiedTool({ provider: "hindsight", hindsightUrl: H_BASE }, "memory_capture_initiative", { bank: BANK, title: "Ctx", summary: "S." }, fetchFn);
  const parsed = JSON.parse(out.content[0].text);
  check("id field still accepted when page_id is absent", !out.isError && parsed.page_id === "kp-alt", out.content[0].text);
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall knowledge page id tests passed");
