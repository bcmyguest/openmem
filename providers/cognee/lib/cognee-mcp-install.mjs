/**
 * Merge a "cognee" stdio MCP into ~/.cursor/mcp.json.
 * Preserves existing hindsight / codegraph / notebooklm / mem0 entries. Never writes secrets.
 */
import fs from "node:fs";
import path from "node:path";
import { envValue } from "../../../wizard/lib/paths.mjs";
import { currentPort, DEFAULT_PORT, ensureState } from "./state.mjs";

/** @typedef {import("../../../wizard/lib/provider-wizard/helpers.mjs").ProviderWizardHelpers} Helpers */

/** Sibling MCP servers this merge must never rewrite. */
export const PRESERVE_MCP_SERVERS = Object.freeze(["hindsight", "codegraph", "notebooklm", "mem0"]);

/** @param {string} repoRoot */
export function cogneeMcpScriptPath(repoRoot) {
  return path.resolve(repoRoot, "cli/cognee-mcp.mjs");
}

/**
 * Host-view Cognee URL (no secrets). Order: COGNEE_API_URL / COGNEE_URL, ctx.cogneeUrl,
 * COGNEE_PORT (env / stack .env / wizard.conf / ctx), then default port.
 * @param {{
 *   home?: string,
 *   stackRoot?: string,
 *   repoRoot?: string,
 *   env?: NodeJS.ProcessEnv,
 *   cogneeUrl?: string,
 *   portCognee?: string | number,
 * }} [opts]
 */
export function resolveCogneeApiUrl(opts = {}) {
  const env = opts.env || process.env;
  const fromUrl = String(env.COGNEE_API_URL || env.COGNEE_URL || opts.cogneeUrl || "").trim();
  if (fromUrl) return fromUrl.replace(/\/+$/, "");

  const home = opts.home || "";
  const stackRoot = opts.stackRoot || opts.repoRoot || "";
  const candidates = [
    env.COGNEE_PORT,
    opts.portCognee,
    stackRoot ? envValue(path.join(stackRoot, ".env"), "COGNEE_PORT") : "",
    home ? envValue(path.join(home, ".config/hindsight/wizard.conf"), "COGNEE_PORT") : "",
  ];
  const port = String(candidates.map((v) => String(v || "").trim()).find((v) => /^\d+$/.test(v)) || DEFAULT_PORT);
  return `http://127.0.0.1:${port}`;
}

/**
 * mcp.json entry: node + script + COGNEE_API_URL only (never COGNEE_API_KEY).
 * @param {string} scriptPath
 * @param {string} [apiUrl]
 */
export function cogneeMcpEntry(scriptPath, apiUrl) {
  const url = String(apiUrl || `http://127.0.0.1:${DEFAULT_PORT}`).replace(/\/+$/, "");
  return {
    command: "node",
    args: [scriptPath],
    env: {
      COGNEE_API_URL: url,
    },
  };
}

/** @deprecated alias — use cogneeMcpEntry */
export const cogneeMcpStubEntry = cogneeMcpEntry;

/**
 * @param {Record<string, any>} mcp
 * @param {string} scriptPath
 * @param {string} [apiUrl]
 * @returns {{ mcp: Record<string, any>, changed: boolean, skipped?: string, refused?: string }}
 */
export function mergeCogneeMcpServer(mcp, scriptPath, apiUrl) {
  const out = { ...mcp };
  const servers = { ...(mcp.mcpServers && typeof mcp.mcpServers === "object" ? mcp.mcpServers : {}) };
  const before = Object.fromEntries(PRESERVE_MCP_SERVERS.map((k) => [k, servers[k]]));
  const next = cogneeMcpEntry(scriptPath, apiUrl);
  const prev = servers.cognee;
  const same = prev && JSON.stringify(prev) === JSON.stringify(next);
  if (same) {
    return { mcp: { ...out, mcpServers: servers }, changed: false, skipped: "already configured" };
  }
  servers.cognee = next;
  for (const k of PRESERVE_MCP_SERVERS) {
    if (before[k] !== undefined && servers[k] !== before[k]) {
      return { mcp, changed: false, refused: `refusing to alter ${k} MCP entry` };
    }
  }
  return { mcp: { ...out, mcpServers: servers }, changed: true };
}

/**
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export async function installCogneeMcp(ctx, h) {
  ensureState(ctx);
  const script = cogneeMcpScriptPath(ctx.repoRoot);
  if (!fs.existsSync(script)) {
    h.warn(`cognee MCP script missing: ${script}`);
    return;
  }

  const apiUrl =
    ctx.cogneeUrl ||
    resolveCogneeApiUrl({
      home: ctx.home,
      stackRoot: ctx.repoRoot,
      repoRoot: ctx.repoRoot,
      env: process.env,
      portCognee: ctx.portCognee || currentPort(ctx),
    });

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

  const snapshots = Object.fromEntries(
    PRESERVE_MCP_SERVERS.map((k) => [k, existing.mcpServers?.[k]]),
  );
  const { mcp, changed, skipped, refused } = mergeCogneeMcpServer(existing, script, apiUrl);
  if (refused) {
    h.warn(refused);
    return;
  }
  for (const k of PRESERVE_MCP_SERVERS) {
    if (snapshots[k] && mcp.mcpServers?.[k] !== snapshots[k]) {
      h.warn(`refusing to alter ${k} MCP entry`);
      return;
    }
  }

  if (!changed) {
    h.ok(`cognee MCP already in ${mcpPath}${skipped ? ` (${skipped})` : ""}`);
    return;
  }
  if (ctx.dry) {
    h.info(`[dry-run] merge cognee MCP into ${mcpPath} → node ${script} (COGNEE_API_URL=${apiUrl}; no API key)`);
    return;
  }
  fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
  fs.writeFileSync(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);
  h.ok(`registered cognee MCP in ${mcpPath}`);
  h.info("Never put COGNEE_API_KEY in mcp.json; export it in the agent environment if auth is enabled");
}
