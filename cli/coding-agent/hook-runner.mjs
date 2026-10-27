#!/usr/bin/env node
/**
 * Session hook entry: node hook-runner.mjs <harness> <sessionStart|prompt|stop>
 * stdin: host hook JSON. Uses unified memory facade (active MEMORY_PROVIDER).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bankFromCwd } from "./bank-from-cwd.mjs";
import { accessAllowed, readAccessConfig } from "./access-policy.mjs";
import { SHIM_HARNESSES } from "./hook-harnesses.mjs";
import { sessionRecall, sessionRetain } from "./session-facade.mjs";
import { resolveMcpContext } from "../mcp/context.mjs";
import { resolveStackRoot } from "../stack.mjs";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function resolveAccess(cwd, config, home = process.env.HOME || os.homedir()) {
  if (!accessAllowed(cwd, config)) return { allowed: false };
  return { allowed: true, bank: bankFromCwd(cwd, { home, mapPathToBank: config.mapPathToBank }) };
}

async function readStdinJson() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
const TRANSCRIPT_MAX_CHARS = 12000;

function blockText(content, acceptedTypes) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && acceptedTypes.includes(part.type) && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function safeAction(label, input) {
  let parsed = input;
  if (typeof input === "string") {
    try { parsed = JSON.parse(input); } catch { /* retain only valid structured arguments */ }
  }
  const summary = parsed && typeof parsed === "object" ? JSON.stringify(parsed) : "";
  return `[action: ${label}${summary ? ` ${summary.slice(0, 800)}` : ""}]`;
}

function parseTranscriptRecord(harnessId, record) {
  if (!record || typeof record !== "object") return [];
  const out = [];
  if (harnessId === "codex") {
    // Best-effort adapter for observed rollout response_item rows. Codex says
    // transcript_path is provided for convenience, but its transcript schema is unstable.
    const payload = record.type === "response_item" ? record.payload : null;
    if (!payload || typeof payload !== "object") return out;
    if (payload.type === "message" && ["user", "assistant"].includes(payload.role)) {
      const accepted = payload.role === "user" ? ["input_text"] : ["output_text"];
      const text = blockText(payload.content, accepted);
      if (text.trim()) out.push(`${payload.role}: ${text.trim()}`);
    } else if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      const label = payload.name || payload.type;
      out.push(safeAction(label, payload.arguments ?? payload.input));
    }
    return out;
  }
  if (harnessId === "claude-code") {
    // Claude transcript message rows use user/assistant roles. Keep only ordinary
    // text and explicit tool-use blocks; thinking and tool-result blocks are omitted.
    const message = record.message;
    if (!["user", "assistant"].includes(message?.role)) return out;
    const text = blockText(message.content, ["text"]);
    if (text.trim()) out.push(`${message.role}: ${text.trim()}`);
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type === "tool_use") out.push(safeAction(part.name || "tool", part.input));
      }
    }
    return out;
  }
  if (harnessId === "cursor-cli") {
    // Observed Cursor agent-transcripts rows have a top-level role and a
    // message.content array. This adapter is based on the local schema shape;
    // live Hook transcript_path linkage remains unverified.
    const role = record.role;
    const message = record.message;
    if (!["user", "assistant"].includes(role) || !Array.isArray(message?.content)) return out;
    const text = blockText(message.content, ["text"]);
    if (text.trim()) out.push(`${role}: ${text.trim()}`);
    if (role === "assistant") {
      for (const part of message.content) {
        if (part?.type === "tool_use") out.push(safeAction(part.name || "tool", part.input));
      }
    }
    return out;
  }
  return out;
}

function cursorFile(home) {
  return path.join(home, ".config", "personal-memory", "transcript-cursors.json");
}

function loadTranscriptCursors(home) {
  try {
    const value = JSON.parse(fs.readFileSync(cursorFile(home), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function saveTranscriptCursors(home, cursors) {
  const file = cursorFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(cursors), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function readNewTranscript(harnessId, transcriptPath, home, sessionId) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  try {
    const stat = fs.statSync(transcriptPath);
    if (!stat.isFile()) return null;
    const key = `${harnessId}:${sessionId || path.resolve(transcriptPath)}`;
    const cursors = loadTranscriptCursors(home);
    const saved = cursors[key];
    const oldPosition = Number.isSafeInteger(saved) ? saved
      : Number.isSafeInteger(saved?.position) ? saved.position : 0;
    const position = oldPosition <= stat.size ? oldPosition : 0;
    let validPosition = position;
    if (position && typeof saved === "object" && saved.anchor) {
      const anchorLength = Math.min(256, position);
      const anchorBuffer = Buffer.alloc(anchorLength);
      const anchorFd = fs.openSync(transcriptPath, "r");
      try { fs.readSync(anchorFd, anchorBuffer, 0, anchorLength, position - anchorLength); }
      finally { fs.closeSync(anchorFd); }
      if (anchorBuffer.toString("base64") !== saved.anchor) validPosition = 0;
    }
    const start = Math.max(validPosition, stat.size - TRANSCRIPT_TAIL_BYTES);
    const length = stat.size - start;
    const fd = fs.openSync(transcriptPath, "r");
    const buffer = Buffer.alloc(length);
    try { fs.readSync(fd, buffer, 0, length, start); } finally { fs.closeSync(fd); }
    const text = buffer.toString("utf8");
    const completeText = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
    const completeLines = completeText.split("\n");
    if (completeLines.at(-1) === "") completeLines.pop();
    if (harnessId === "cursor-cli") {
      // Do not create a cursor for unknown or unverified row shapes. A single
      // structurally recognized message row enables the bounded adapter.
      const recognized = completeLines.some((line) => {
        try {
          const record = JSON.parse(line);
          return ["user", "assistant"].includes(record?.role) && Array.isArray(record?.message?.content);
        } catch { return false; }
      });
      if (!recognized) return null;
    }
    const extracted = [];
    for (const line of completeLines) {
      if (!line.trim()) continue;
      try { extracted.push(...parseTranscriptRecord(harnessId, JSON.parse(line))); } catch { /* ignore malformed rows */ }
    }
    const content = extracted.join("\n").slice(-TRANSCRIPT_MAX_CHARS).trim();
    // A bounded tail can begin mid-row. If it contains no newline, do not
    // checkpoint that interior offset; retry from the last known boundary.
    const nextPosition = completeText.length
      ? start + Buffer.byteLength(completeText)
      : validPosition;
    const anchorLength = Math.min(256, nextPosition);
    const anchorBuffer = Buffer.alloc(anchorLength);
    const anchorFd = fs.openSync(transcriptPath, "r");
    try {
      if (anchorLength) fs.readSync(anchorFd, anchorBuffer, 0, anchorLength, nextPosition - anchorLength);
    } finally { fs.closeSync(anchorFd); }
    return {
      key, cursors, position: { position: nextPosition, anchor: anchorBuffer.toString("base64") }, content,
    };
  } catch { return null; }
}

export async function runHook(harnessId, phase, { home, env, repoRoot, ev, fetchFn = fetch }) {
  const spec = SHIM_HARNESSES[harnessId];
  if (!spec) throw new Error(`unknown harness ${harnessId}`);
  const parsed = spec.parse[phase](ev);
  const config = readAccessConfig(home);
  const access = config ? resolveAccess(parsed.cwd, config, home) : { allowed: false };
  if (!access.allowed) return spec.emit[phase](undefined);
  const bank = access.bank;
  let runtimeConfig = {};
  try {
    runtimeConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, "agent-runtime.json"), "utf8"));
  } catch {
    // Checkout and direct test calls use ordinary stack resolution.
  }
  const runtimeEnv = { ...env, PM_STACK_ROOT: env.PM_STACK_ROOT || runtimeConfig.stackRoot };
  const stack = resolveStackRoot({ pkgRoot: repoRoot, env: runtimeEnv, home });
  const ctx = resolveMcpContext({ home, stackRoot: stack.root, repoRoot, env: runtimeEnv });
  let context = "";

  if (phase === "sessionStart") {
    context = await sessionRecall(
      ctx,
      { query: "What should I know about this project and recent decisions?", bank, limit: 8,
        budget: "low", maxTokens: 1200 },
      fetchFn,
    );
  } else if (phase === "prompt") {
    const q = String(parsed.prompt || "").trim();
    if (q) {
      context = await sessionRecall(ctx, { query: q, bank, limit: 8 }, fetchFn);
    }
  } else if (phase === "stop") {
    const transcript = readNewTranscript(harnessId, parsed.transcriptPath, home, parsed.sessionId);
    if (transcript) {
      if (transcript.content) {
        await sessionRetain(
          ctx,
          {
            bank,
            content: `Session turn (${harnessId} ${parsed.sessionId || "unknown"}):\n${transcript.content}`,
          },
          fetchFn,
        );
      }
      transcript.cursors[transcript.key] = transcript.position;
      saveTranscriptCursors(home, transcript.cursors);
    }
    return spec.emit.stop();
  }

  return spec.emit[phase](context?.trim() || undefined);
}

async function main() {
  const [harnessId, phase] = process.argv.slice(2);
  if (!harnessId || !phase || !SHIM_HARNESSES[harnessId]?.parse[phase]) {
    console.error("usage: hook-runner.mjs <claude-code|codex|cursor-cli> <sessionStart|prompt|stop>");
    process.exit(2);
  }
  try {
    const ev = await readStdinJson();
    const out = await runHook(harnessId, phase, {
      home: process.env.HOME || os.homedir(),
      env: process.env,
      repoRoot: PKG_ROOT,
      ev,
    });
    if (out && Object.keys(out).length) process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch (err) {
    console.error(`openmem hook: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(self)) main();
