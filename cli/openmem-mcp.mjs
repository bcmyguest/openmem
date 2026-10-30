#!/usr/bin/env node
/**
 * Unified openmem MCP: stable memory_* tools delegating to the active provider.
 *
 *   openmem-mcp
 *   node cli/openmem-mcp.mjs
 *
 * Provider: MEMORY_PROVIDER → ~/.config/hindsight/wizard.conf → hindsight.
 * Stack/env resolution matches install-mcp (HINDSIGHT_URL, mem0 URL + key file, Cognee URL).
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";
import { resolveMcpContext } from "./mcp/context.mjs";
import { startContextStore } from "./mcp/context-store.mjs";
import { handleUnifiedMessage } from "./mcp/memory-facade.mjs";
import { serveStdio } from "./mcp/stdio.mjs";
import { resolveStackRoot } from "./stack.mjs";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const home = process.env.HOME || os.homedir();
  const stack = resolveStackRoot({ pkgRoot: PKG_ROOT, env: process.env, home });
  const ctx = resolveMcpContext({ home, stackRoot: stack.root, repoRoot: PKG_ROOT, env: process.env });
  // Session-file TTL cleanup (docs/context-store.md, "Retention"), at most once a day; never throws.
  await startContextStore(process.env, { home, stackRoot: stack.root });
  process.stdin.resume();
  await serveStdio(process.stdin, (msg) => handleUnifiedMessage(msg, ctx));
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`openmem-mcp: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
