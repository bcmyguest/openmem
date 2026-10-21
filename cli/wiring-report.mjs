#!/usr/bin/env node
/** Agent wiring report: provider, API URLs, MCP entries vs expectations. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMcpContext } from "./mcp/context.mjs";
import { resolveMemoryProvider, shouldInstallNotebooklm } from "./install-memory-mcp.mjs";
import { resolveStackRoot } from "./stack.mjs";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * @param {{ home: string, stackRoot: string, repoRoot: string, env?: NodeJS.ProcessEnv }} opts
 */
export function buildWiringReport(opts) {
  const home = opts.home;
  const env = opts.env || process.env;
  const provider = resolveMemoryProvider(home, env);
  const ctx = resolveMcpContext({ ...opts, home, env });
  const mcpPath = path.join(home, ".cursor/mcp.json");
  /** @type {Record<string, unknown>} */
  let mcp = {};
  if (fs.existsSync(mcpPath)) {
    try {
      mcp = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
    } catch {
      mcp = { _parseError: true };
    }
  }
  const servers = mcp.mcpServers && typeof mcp.mcpServers === "object" ? mcp.mcpServers : {};
  const names = Object.keys(servers);
  const expectUnified = true;
  const expectProviderNative = provider === "mem0" || provider === "cognee";
  const nlm = shouldInstallNotebooklm({
    home,
    flags: { notebooklm: false, notebooklmOnly: false, providerOnly: false },
  });
  const issues = [];
  if (expectUnified && !servers["personal-memory"]) {
    issues.push("missing unified MCP server `personal-memory` in ~/.cursor/mcp.json (run install-mcp)");
  }
  if (expectProviderNative && !servers[provider]) {
    issues.push(`active provider is ${provider} but mcp.json has no \`${provider}\` entry (optional: install-mcp --provider-only)`);
  }
  if (provider === "hindsight" && servers.mem0) {
    issues.push("MEMORY_PROVIDER is hindsight but mcp.json still has mem0 (stale after switch?)");
  }
  if (provider === "mem0" && servers.hindsight && servers.hindsight.command !== "keep") {
    /* hindsight key often kept intentionally */
  }
  const manifestPath = path.join(opts.repoRoot, "providers", provider, "manifest.json");
  let sinkDriver = null;
  if (fs.existsSync(manifestPath)) {
    try {
      sinkDriver = JSON.parse(fs.readFileSync(manifestPath, "utf8"))?.indexer?.sinkDriver ?? null;
    } catch {
      sinkDriver = null;
    }
  }
  return {
    memory_provider: provider,
    api: {
      hindsightUrl: ctx.hindsightUrl ?? null,
      mem0BaseUrl: ctx.mem0?.baseUrl ?? null,
      cogneeBaseUrl: ctx.cognee?.baseUrl ?? null,
    },
    indexer: { sink_driver: sinkDriver },
    mcp: {
      path: mcpPath,
      servers: names,
      notebooklm_recommended: nlm,
      has_notebooklm: Boolean(servers.notebooklm),
    },
    coding_agent: {
      hindsight_plugin: provider === "hindsight" ? "@vectorize-io/hindsight-coding-agents" : null,
      non_hindsight_session: provider !== "hindsight" ? "use personal-memory MCP memory_* (install-mcp)" : null,
    },
    issues,
    ok: issues.length === 0,
  };
}

function main() {
  const json = process.argv.includes("--json");
  const home = process.env.HOME || "";
  const sr = resolveStackRoot({ pkgRoot: PKG_ROOT });
  const report = buildWiringReport({ home, stackRoot: sr.root, repoRoot: PKG_ROOT, env: process.env });
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : 1);
  }
  console.log(`Memory provider: ${report.memory_provider}`);
  if (report.api.hindsightUrl) console.log(`  Hindsight: ${report.api.hindsightUrl}`);
  if (report.api.mem0BaseUrl) console.log(`  mem0: ${report.api.mem0BaseUrl}`);
  if (report.api.cogneeBaseUrl) console.log(`  Cognee: ${report.api.cogneeBaseUrl}`);
  if (report.indexer.sink_driver) console.log(`  Indexer sink: ${report.indexer.sink_driver}`);
  console.log(`MCP (${report.mcp.path}): ${report.mcp.servers.join(", ") || "(none)"}`);
  if (report.mcp.notebooklm_recommended && !report.mcp.has_notebooklm) {
    console.log("  NotebookLM sync enabled but notebooklm MCP not in mcp.json");
  }
  if (report.coding_agent.hindsight_plugin) {
    console.log(`Session plugin: ${report.coding_agent.hindsight_plugin}`);
  } else if (report.coding_agent.non_hindsight_session) {
    console.log(`Session memory: ${report.coding_agent.non_hindsight_session}`);
  }
  for (const i of report.issues) console.log(`Issue: ${i}`);
  process.exit(report.ok ? 0 : 1);
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
