#!/usr/bin/env node
// MCP session-id sanitizer and state-dir resolver match the hook side (docs/context-store.md rule).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { callContextStoreTool, contextRoot, sanitizeSessionId } from "../../cli/mcp/context-store.mjs";
import { registerSession } from "../../cli/coding-agent/context-store.mjs";
import { writeSessionRows } from "./fixtures/session-db.mjs";

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok    ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}
function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

const CASES = [
  [" abc", "abc"],
  ["abc\n", "abc"],
  ["é", "_"],
  ["😀", "_"],
  ["a b:c", "a_b_c"],
  ["ses_01J-9.x", "ses_01J-9.x"],
];
for (const [raw, want] of CASES) {
  const got = sanitizeSessionId(raw);
  check(`sanitize ${JSON.stringify(raw)} -> ${JSON.stringify(want)}`, got === want, JSON.stringify(got));
}
check("sanitized ids contain no path separator", CASES.every(([raw]) => !/[/\\]/.test(sanitizeSessionId(raw))));
for (const raw of ["", "   ", null, undefined]) {
  check(`empty id ${JSON.stringify(raw)} rejected`, throws(() => sanitizeSessionId(raw)));
}
check("sanitize \"a..b\" keeps the dots", sanitizeSessionId("a..b") === "a..b");
for (const raw of ["a/b", "a\\b", "../x", "..", "."]) {
  check(`explicit search id ${JSON.stringify(raw)} rejected`, throws(() => sanitizeSessionId(raw)));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openmem-ctx-sid-"));
const state = path.join(tmp, "state");
{
  const env = { HOME: tmp, OPENMEM_STATE_DIR: `  ${state}\n` };
  check("contextRoot trims OPENMEM_STATE_DIR", contextRoot(env) === path.join(state, "context"), contextRoot(env));
  check("blank OPENMEM_STATE_DIR falls back to HOME default", contextRoot({ HOME: tmp, OPENMEM_STATE_DIR: "  " }) === path.join(tmp, ".local", "share", "openmem", "context"));
}

{
  // Parity: the sanitized id the hook registers (and the pointer names) is the id the MCP searches.
  const env = { HOME: tmp, OPENMEM_STATE_DIR: state };
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(repo, { recursive: true });
  for (const raw of ["a/b", "a..b", "x\\y", "ses:1"]) {
    const file = registerSession({ home: tmp, env, sessionId: raw, agent: "claude-code", cwd: repo, bank: "b" });
    const sid = path.basename(file, ".json");
    writeSessionRows(path.dirname(file), sid, [{ role: "user", kind: "text", name: null, text: "parity needle" }]);
    const r = await callContextStoreTool("smart_compact_search", { query: "parity needle", session_id: sid }, { env, cwd: repo });
    check(`hook-registered ${JSON.stringify(raw)} is found by the MCP`, r.sessions_searched[0] === sid && r.results.length === 1, JSON.stringify(r.sessions_searched));
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall context store sid tests passed");
