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
import { SHIM_HARNESSES } from "./hook-harnesses.mjs";
import { sessionRecall, sessionReflectOrSearch, sessionRetain } from "./session-facade.mjs";
import { resolveMcpContext } from "../mcp/context.mjs";
import { resolveStackRoot } from "../stack.mjs";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function readStdinJson() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function readTranscriptTail(transcriptPath, maxChars = 12000) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return "";
  try {
    const text = fs.readFileSync(transcriptPath, "utf8");
    return text.length > maxChars ? text.slice(-maxChars) : text;
  } catch {
    return "";
  }
}

export async function runHook(harnessId, phase, { home, env, repoRoot, ev, fetchFn = fetch }) {
  const spec = SHIM_HARNESSES[harnessId];
  if (!spec) throw new Error(`unknown harness ${harnessId}`);
  const stack = resolveStackRoot({ pkgRoot: repoRoot, env, home });
  const ctx = resolveMcpContext({ home, stackRoot: stack.root, repoRoot, env });
  const parsed = spec.parse[phase](ev);
  const bank = bankFromCwd(parsed.cwd);
  let context = "";

  if (phase === "sessionStart") {
    context = await sessionReflectOrSearch(
      ctx,
      { query: "What should I know about this project and recent decisions?", bank, limit: 12 },
      fetchFn,
    );
  } else if (phase === "prompt") {
    const q = String(parsed.prompt || "").trim();
    if (q) {
      context = await sessionRecall(ctx, { query: q, bank, limit: 8 }, fetchFn);
    }
  } else if (phase === "stop") {
    const tail = readTranscriptTail(parsed.transcriptPath);
    if (tail) {
      await sessionRetain(
        ctx,
        {
          bank,
          content: `Session transcript tail (${harnessId} ${parsed.sessionId || "unknown"}):\n${tail}`,
        },
        fetchFn,
      );
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
    console.error(`personal-memory hook: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(self)) main();
