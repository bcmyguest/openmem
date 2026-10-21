import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeNamedMcpServer } from "../install-memory-mcp.mjs";

/** @param {string} repoRoot */
export function unifiedMcpScriptPath(repoRoot) {
  return path.resolve(repoRoot, "cli/personal-memory-mcp.mjs");
}

/**
 * @param {{ provider: string, scriptPath: string, stackRoot?: string }} opts
 */
export function unifiedMcpEntry({ provider, scriptPath, stackRoot }) {
  /** @type {Record<string, string>} */
  const env = { MEMORY_PROVIDER: provider };
  if (stackRoot) env.PM_STACK_ROOT = stackRoot;
  return {
    command: "node",
    args: [scriptPath],
    env,
  };
}

/**
 * @param {{ home: string, repoRoot: string, stackRoot: string, provider: string, dry?: boolean }} opts
 * @param {{ ok: Function, info: Function }} h
 */
export function installUnifiedMcp(opts, h) {
  const mcpPath = path.join(opts.home, ".cursor/mcp.json");
  const entry = unifiedMcpEntry({
    provider: opts.provider,
    scriptPath: unifiedMcpScriptPath(opts.repoRoot),
    stackRoot: opts.stackRoot,
  });
  if (opts.dry) {
    h.info(`[dry-run] merge personal-memory MCP into ${mcpPath}`);
    return { changed: false };
  }
  const mcp = fs.existsSync(mcpPath) ? JSON.parse(fs.readFileSync(mcpPath, "utf8")) : {};
  const { mcp: next, changed, skipped } = mergeNamedMcpServer(mcp, "personal-memory", entry, {
    protect: ["hindsight", "codegraph", "notebooklm", "mem0", "cognee"],
  });
  if (changed) {
    fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
    fs.writeFileSync(mcpPath, `${JSON.stringify(next, null, 2)}\n`);
    h.ok(`personal-memory MCP → ${mcpPath}`);
  } else if (skipped) {
    h.info(`personal-memory MCP ${skipped}`);
  } else {
    h.info("personal-memory MCP already configured");
  }
  return { changed: Boolean(changed) };
}

/** @param {string} [pkgRoot] */
export function defaultUnifiedMcpScriptPath(pkgRoot) {
  const root = pkgRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  return unifiedMcpScriptPath(root);
}
