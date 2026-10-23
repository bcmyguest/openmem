#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runHook } from "../../cli/coding-agent/hook-runner.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "transcripts");
const checks = [];
function check(name, condition) { checks.push([name, Boolean(condition)]); }

function mockMemory({ fail = false } = {}) {
  const retained = [];
  const fetchFn = async (_url, init) => {
    if (fail) return { ok: false, status: 503, text: async () => "offline" };
    if (init?.method === "POST") {
      const body = JSON.parse(init.body);
      retained.push(body.data || body.memory || body.content || body.messages?.[0]?.content || "");
      // mem0 accepts {messages:[{role,content}]} for memory creation.
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: "stored" }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ results: [] }) };
  };
  return { fetchFn, retained };
}

async function invoke(harnessId, home, transcriptPath, sessionId, fetchFn) {
  return runHook(harnessId, "stop", {
    home,
    env: { ...process.env, HOME: home, MEMORY_PROVIDER: "mem0", MEM0_API_URL: "http://127.0.0.1:19999" },
    repoRoot: ROOT,
    ev: { cwd: "/tmp/transcript-project", transcript_path: transcriptPath, session_id: sessionId },
    fetchFn,
  });
}

for (const [harness, fixture, expected] of [
  ["claude-code", "claude-code.jsonl", [
    "user: Implement a bounded transcript reader",
    "assistant: I will parse known message rows.",
    '[action: Read {"file_path":"src/main.mjs"}]',
  ]],
  ["codex", "codex-rollout.jsonl", [
    "user: Fix the startup bug",
    '[action: shell {"command":"npm test"}]',
    "assistant: The startup path now validates configuration.",
  ]],
]) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pm-transcript-"));
  const transcriptPath = path.join(home, "transcript.jsonl");
  fs.copyFileSync(path.join(FIXTURES, fixture), transcriptPath);
  const mock = mockMemory();
  await invoke(harness, home, transcriptPath, "session-1", mock.fetchFn);
  const retained = mock.retained[0] || "";
  const actual = retained.split("\n").slice(1);
  check(`${harness}: retains exact expected messages/actions`, JSON.stringify(actual) === JSON.stringify(expected));
  check(`${harness}: excludes reasoning, startup metadata, and tool results`, !/private reasoning|large file result|session_meta|timestamp/.test(retained));
  await invoke(harness, home, transcriptPath, "session-1", mock.fetchFn);
  check(`${harness}: repeated stop does not retain prior records`, mock.retained.length === 1);
  fs.rmSync(home, { recursive: true, force: true });
}

{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pm-transcript-cursor-unknown-"));
  const transcriptPath = path.join(home, "transcript.jsonl");
  fs.writeFileSync(transcriptPath, '{"unknown_host_record":true}\n');
  const mock = mockMemory();
  await invoke("cursor-cli", home, transcriptPath, "cursor-unknown", mock.fetchFn);
  check("unknown Cursor row shape is skipped", mock.retained.length === 0);
  check("unknown Cursor format does not create a cursor", !fs.existsSync(path.join(home, ".config/personal-memory/transcript-cursors.json")));
  fs.rmSync(home, { recursive: true, force: true });
}

{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pm-transcript-cursor-agent-"));
  const transcriptPath = path.join(home, "transcript.jsonl");
  // Synthetic rows model only the observed agent-transcripts schema shape.
  fs.writeFileSync(transcriptPath, [
    { role: "user", message: { content: [{ type: "text", text: "Review the cache invalidation path." }] } },
    { role: "assistant", message: { content: [
      { type: "text", text: "I found the stale entry." },
      { type: "tool_use", name: "Read", input: { file_path: "src/cache.mjs" } },
    ] } },
    { type: "turn_ended" },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  const mock = mockMemory();
  await invoke("cursor-cli", home, transcriptPath, "cursor-agent-1", mock.fetchFn);
  const retained = mock.retained[0] || "";
  const actual = retained.split("\n").slice(1);
  check("Cursor observed row shape retains exact text and tool action", JSON.stringify(actual) === JSON.stringify([
    "user: Review the cache invalidation path.",
    "assistant: I found the stale entry.",
    '[action: Read {"file_path":"src/cache.mjs"}]',
  ]));
  await invoke("cursor-cli", home, transcriptPath, "cursor-agent-1", mock.fetchFn);
  check("Cursor duplicate stop does not retain prior records", mock.retained.length === 1);
  fs.rmSync(home, { recursive: true, force: true });
}

{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pm-transcript-retry-"));
  const transcriptPath = path.join(home, "transcript.jsonl");
  fs.copyFileSync(path.join(FIXTURES, "claude-code.jsonl"), transcriptPath);
  let failed = false;
  try { await invoke("claude-code", home, transcriptPath, "retry-1", mockMemory({ fail: true }).fetchFn); } catch { failed = true; }
  const afterFailure = fs.existsSync(path.join(home, ".config/personal-memory/transcript-cursors.json"))
    ? JSON.parse(fs.readFileSync(path.join(home, ".config/personal-memory/transcript-cursors.json"), "utf8"))
    : {};
  check("backend failure propagates to permit host retry", failed);
  check("backend failure does not advance the session cursor", afterFailure["claude-code:retry-1"] === undefined);
  const retry = mockMemory();
  await invoke("claude-code", home, transcriptPath, "retry-1", retry.fetchFn);
  check("retry retains pending new content", retry.retained.length === 1);

  const originalSize = fs.statSync(transcriptPath).size;
  const rewritten = `${JSON.stringify({ type: "user", message: { role: "user", content: "Rewrite detected" } })}\n`;
  fs.writeFileSync(transcriptPath, rewritten.padEnd(originalSize + 10, " "));
  await invoke("claude-code", home, transcriptPath, "retry-1", retry.fetchFn);
  check("same-path rewrite at or beyond old size resets cursor", retry.retained.length === 2 && retry.retained[1].includes("user: Rewrite detected"));
  fs.rmSync(home, { recursive: true, force: true });
}

{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pm-transcript-oversized-line-"));
  const transcriptPath = path.join(home, "transcript.jsonl");
  fs.writeFileSync(transcriptPath, Buffer.alloc(256 * 1024 + 512, 0x61));
  const mock = mockMemory();
  await invoke("claude-code", home, transcriptPath, "oversized-1", mock.fetchFn);
  const cursorsPath = path.join(home, ".config/personal-memory/transcript-cursors.json");
  const firstCursor = JSON.parse(fs.readFileSync(cursorsPath, "utf8"))["claude-code:oversized-1"];
  check("unterminated oversized row leaves cursor at prior boundary", firstCursor.position === 0);

  const later = JSON.stringify({ type: "user", message: { role: "user", content: "Later complete row" } });
  fs.appendFileSync(transcriptPath, `\n${later}\n`);
  await invoke("claude-code", home, transcriptPath, "oversized-1", mock.fetchFn);
  check("later row survives after oversized row closes", mock.retained.length === 1 && mock.retained[0].includes("user: Later complete row"));
  fs.rmSync(home, { recursive: true, force: true });
}

for (const [name, passed] of checks) console.log(`${passed ? "ok" : "FAIL"} ${name}`);
if (checks.some(([, passed]) => !passed)) process.exit(1);
console.log("all transcript retention tests passed");
