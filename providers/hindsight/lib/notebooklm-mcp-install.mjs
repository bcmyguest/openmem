/**
 * When notebooklmAccess.enabled, merge a "notebooklm" stdio MCP into ~/.cursor/mcp.json.
 * Never overwrites existing "hindsight" or "codegraph" entries. Dry-run safe.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveAccess, loadCodingAgentConfig } from "../../../cli/notebooklm-mcp.mjs";

/** @typedef {import("../../../wizard/lib/provider-wizard/helpers.mjs").ProviderWizardHelpers} Helpers */

/** @param {string} repoRoot */
export function notebooklmMcpScriptPath(repoRoot) {
  return path.resolve(repoRoot, "cli/notebooklm-mcp.mjs");
}

/**
 * @param {Record<string, any>} mcp
 * @param {string} scriptPath absolute path to cli/notebooklm-mcp.mjs
 * @returns {{ mcp: Record<string, any>, changed: boolean, skipped?: string }}
 */
export function mergeNotebooklmMcpServer(mcp, scriptPath) {
  const out = { ...mcp };
  const servers = { ...(mcp.mcpServers && typeof mcp.mcpServers === "object" ? mcp.mcpServers : {}) };
  const next = {
    command: "node",
    args: [scriptPath],
  };
  const prev = servers.notebooklm;
  const same =
    prev &&
    prev.command === next.command &&
    Array.isArray(prev.args) &&
    prev.args.length === 1 &&
    prev.args[0] === scriptPath;
  if (same) return { mcp: { ...out, mcpServers: servers }, changed: false, skipped: "already configured" };
  servers.notebooklm = next;
  // Preserve sibling servers by reference identity of keys we did not touch.
  return { mcp: { ...out, mcpServers: servers }, changed: true };
}

/**
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export async function installNotebooklmMcp(ctx, h) {
  const agentPath = ctx.agentJson || path.join(ctx.home, ".hindsight", "coding-agent.json");
  const tracked = path.join(ctx.repoRoot, "config/coding-agent.json");
  let cfg = null;
  for (const p of [agentPath, tracked]) {
    try {
      if (fs.existsSync(p)) {
        cfg = loadCodingAgentConfig(p);
        break;
      }
    } catch {
      /* try next */
    }
  }
  if (!cfg) {
    h.info("notebooklm MCP: no coding-agent.json yet; skip Cursor mcp.json merge");
    return;
  }
  const access = resolveAccess(cfg);
  if (!access.enabled) {
    h.info("notebooklmAccess.enabled is false; skip registering notebooklm MCP in ~/.cursor/mcp.json");
    return;
  }

  const script = notebooklmMcpScriptPath(ctx.repoRoot);
  if (!fs.existsSync(script)) {
    h.warn(`notebooklm MCP script missing: ${script}`);
    return;
  }

  const mcpPath = path.join(ctx.home, ".cursor", "mcp.json");
  let existing = {};
  if (fs.existsSync(mcpPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
    } catch (err) {
      h.warn(`cannot parse ${mcpPath}: ${err instanceof Error ? err.message : err}`);
      return;
    }
  }

  // Guard: never clobber unrelated servers (merge only adds/updates "notebooklm").
  const beforeHindsight = existing.mcpServers?.hindsight;
  const beforeCodegraph = existing.mcpServers?.codegraph;
  const { mcp, changed, skipped } = mergeNotebooklmMcpServer(existing, script);
  if (beforeHindsight && mcp.mcpServers?.hindsight !== beforeHindsight) {
    h.warn("refusing to alter hindsight MCP entry");
    return;
  }
  if (beforeCodegraph && mcp.mcpServers?.codegraph !== beforeCodegraph) {
    h.warn("refusing to alter codegraph MCP entry");
    return;
  }

  if (!changed) {
    h.ok(`notebooklm MCP already in ${mcpPath}${skipped ? ` (${skipped})` : ""}`);
    return;
  }
  if (ctx.dry) {
    h.info(`[dry-run] merge notebooklm MCP into ${mcpPath} → node ${script}`);
    return;
  }
  fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
  fs.writeFileSync(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);
  h.ok(`registered notebooklm MCP in ${mcpPath}`);
}
