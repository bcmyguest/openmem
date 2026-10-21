#!/usr/bin/env node
/**
 * Unified personal-memory MCP: stable memory_* tools delegating to the active provider.
 *
 *   personal-memory-mcp
 *   node cli/personal-memory-mcp.mjs
 *
 * Provider: MEMORY_PROVIDER → ~/.config/hindsight/wizard.conf → hindsight.
 * Stack/env resolution matches install-mcp (HINDSIGHT_URL, mem0 URL + key file, Cognee URL).
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMcpContext } from "./mcp/context.mjs";
import { handleUnifiedMessage } from "./mcp/memory-facade.mjs";
import { serveStdio } from "./mcp/stdio.mjs";
import { resolveStackRoot } from "./stack.mjs";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const home = process.env.HOME || os.homedir();
  const stack = resolveStackRoot({ pkgRoot: PKG_ROOT, env: process.env, home });
  const ctx = resolveMcpContext({ home, stackRoot: stack.root, repoRoot: PKG_ROOT, env: process.env });
  process.stdin.resume();
  await serveStdio(process.stdin, (msg) => handleUnifiedMessage(msg, ctx));
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(thisFile)) {
  main().catch((err) => {
    console.error(`personal-memory-mcp: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
