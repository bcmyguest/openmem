#!/usr/bin/env node
import assert from "node:assert/strict";
import { callMemoryReflect } from "../../cli/mcp/memory-reflect-consolidate.mjs";

const calls = [];
const fetchFn = async (url, options) => {
  calls.push({ url: String(url), options });
  return { ok: true, status: 200, text: async () => JSON.stringify({ text: "The answer", based_on: [{ id: "fact-1" }] }) };
};

const output = await callMemoryReflect(
  { provider: "hindsight", hindsightUrl: "http://127.0.0.1:8888/" },
  { query: "What changed?", bank: "coding-agent::project" },
  async () => { throw new Error("search fallback must not run"); },
  fetchFn,
);
assert.equal(calls.length, 1);
assert.equal(calls[0].url, "http://127.0.0.1:8888/v1/default/banks/coding-agent%3A%3Aproject/reflect");
assert.equal(calls[0].options.method, "POST");
assert.deepEqual(JSON.parse(calls[0].options.body), { query: "What changed?", budget: "low", max_tokens: 1024 });
assert.equal(output.mode, "hindsight_reflect");
assert.equal(output.answer, "The answer");
assert.deepEqual(output.result.based_on, [{ id: "fact-1" }]);
console.log("Hindsight memory_reflect uses the reflect endpoint");
