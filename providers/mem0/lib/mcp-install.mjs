/**
 * Merge a usable mem0 MCP into ~/.cursor/mcp.json for the self-hosted REST server.
 *
 * Upstream stdio bridge: npx -y @yeyuan98/mem0-mcp (fronts MEM0_BASE_URL with X-API-Key).
 * Official Mem0 MCP is cloud-only (https://mcp.mem0.ai); the OSS docs page is gone.
 *
 * mcp.json never holds MEM0_API_KEY. The launcher (cli/mem0-mcp.mjs) loads the key from
 * MEM0_ENV_FILE / ~/.config/personal-memory/mem0.env when the process env lacks it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { envValue } from "../../../wizard/lib/paths.mjs";
import { DEFAULT_API_URL, defaultEnvFile } from "./state.mjs";

/** Sibling MCP servers this merge must never rewrite. */
export const MEM0_MCP_PROTECTED = Object.freeze(["hindsight", "codegraph", "notebooklm"]);

/** npm package that speaks the open-source REST API (not platform mcp.mem0.ai). */
export const MEM0_MCP_NPM_PACKAGE = "@yeyuan98/mem0-mcp";

/** @param {string} [pkgRoot] absolute package / checkout root */
export function mem0McpScriptPath(pkgRoot) {
  const root =
    pkgRoot ||
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  return path.resolve(root, "cli/mem0-mcp.mjs");
}

/**
 * MEM0_API_URL from env, stack .env, wizard.conf, then default. Never returns secrets.
 * @param {{ home: string, stackRoot: string, env?: NodeJS.ProcessEnv }} opts
 */
export function resolveMem0ApiUrl({ home, stackRoot, env = process.env }) {
  const candidates = [
    env.MEM0_API_URL,
    env.PM_MEM0_API_URL,
    envValue(path.join(stackRoot, ".env"), "MEM0_API_URL"),
    envValue(path.join(home, ".config/hindsight/wizard.conf"), "MEM0_API_URL"),
  ];
  const first = candidates.map((v) => String(v || "").trim()).find(Boolean);
  return (first || DEFAULT_API_URL).replace(/\/+$/, "");
}

/**
 * Path to the API key file (path only — never read the key here).
 * @param {{ home: string, stackRoot: string, env?: NodeJS.ProcessEnv }} opts
 */
export function resolveMem0EnvFilePath({ home, stackRoot, env = process.env }) {
  const candidates = [
    env.MEM0_ENV_FILE,
    envValue(path.join(stackRoot, ".env"), "MEM0_ENV_FILE"),
  ];
  const raw = candidates.map((v) => String(v || "").trim()).find(Boolean);
  if (!raw) return defaultEnvFile(home);
  if (raw.startsWith("~/")) return path.join(home, raw.slice(2));
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(stackRoot, raw);
}

/**
 * Cursor mcp.json entry: node launcher → npx @yeyuan98/mem0-mcp.
 * Sets MEM0_API_URL + MEM0_BASE_URL (upstream reads BASE_URL). Path to key file only.
 * @param {{ apiUrl: string, scriptPath: string, envFile?: string }} opts
 */
export function mem0McpEntry({ apiUrl, scriptPath, envFile }) {
  const url = String(apiUrl || "").replace(/\/+$/, "");
  /** @type {Record<string, string>} */
  const env = {
    MEM0_API_URL: url,
    MEM0_BASE_URL: url,
  };
  if (envFile) env.MEM0_ENV_FILE = envFile;
  return {
    command: "node",
    args: [scriptPath],
    env,
  };
}

/**
 * @param {Record<string, any>} mcp
 * @param {{ apiUrl: string, scriptPath: string, envFile?: string }} opts
 * @returns {{ mcp: Record<string, any>, changed: boolean, skipped?: string, refused?: string }}
 */
export function mergeMem0McpServer(mcp, opts) {
  const entry = mem0McpEntry(opts);
  const out = { ...mcp };
  const servers = {
    ...(mcp.mcpServers && typeof mcp.mcpServers === "object" ? mcp.mcpServers : {}),
  };
  const before = Object.fromEntries(MEM0_MCP_PROTECTED.map((k) => [k, servers[k]]));
  const prev = servers.mem0;
  const same = prev && JSON.stringify(prev) === JSON.stringify(entry);
  if (same) {
    return { mcp: { ...out, mcpServers: servers }, changed: false, skipped: "already configured" };
  }
  servers.mem0 = entry;
  for (const k of MEM0_MCP_PROTECTED) {
    if (before[k] !== undefined && servers[k] !== before[k]) {
      return { mcp, changed: false, refused: `refusing to alter ${k} MCP entry` };
    }
  }
  return { mcp: { ...out, mcpServers: servers }, changed: true };
}

/**
 * @param {{
 *   home: string,
 *   repoRoot: string,
 *   stackRoot: string,
 *   dry?: boolean,
 *   env?: NodeJS.ProcessEnv,
 * }} ctx
 * @param {{ info: Function, ok: Function, warn: Function }} h
 */
export async function installMem0Mcp(ctx, h) {
  const env = ctx.env || process.env;
  const apiUrl = resolveMem0ApiUrl({ home: ctx.home, stackRoot: ctx.stackRoot, env });
  const envFile = resolveMem0EnvFilePath({ home: ctx.home, stackRoot: ctx.stackRoot, env });
  const scriptPath = mem0McpScriptPath(ctx.repoRoot);
  if (!fs.existsSync(scriptPath)) {
    h.warn(`mem0 MCP launcher missing: ${scriptPath}`);
    return { changed: false };
  }

  const mcpPath = path.join(ctx.home, ".cursor", "mcp.json");
  let existing = {};
  if (fs.existsSync(mcpPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
    } catch (err) {
      h.warn(`cannot parse ${mcpPath}: ${err instanceof Error ? err.message : err}`);
      return { changed: false };
    }
  }

  const { mcp, changed, skipped, refused } = mergeMem0McpServer(existing, {
    apiUrl,
    scriptPath,
    envFile,
  });
  if (refused) {
    h.warn(refused);
    return { changed: false, refused };
  }
  if (!changed) {
    h.ok(`mem0 MCP already in ${mcpPath}${skipped ? ` (${skipped})` : ""}`);
    return { changed: false, skipped };
  }
  if (ctx.dry) {
    h.info(
      `[dry-run] merge mem0 MCP into ${mcpPath} → node ${scriptPath}` +
        ` (MEM0_API_URL=${apiUrl}; key via ${envFile} or MEM0_API_KEY in the agent env — never written to mcp.json)`,
    );
    return { changed: true, dry: true };
  }
  fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
  fs.writeFileSync(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);
  h.ok(`registered mem0 MCP in ${mcpPath}`);
  h.info(
    `API key: export MEM0_API_KEY from ${envFile} (or leave it for the launcher to load). Never put the key in mcp.json.`,
  );
  return { changed: true };
}
