/**
 * Opt-in coding-agent NotebookLM MCP access: materialize ~/.hindsight/coding-agent.json
 * as a real file (never write machine settings into the repo template) and toggle
 * notebooklmAccess.enabled.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * @param {string} agentPath ~/.hindsight/coding-agent.json
 * @param {string} templatePath repo config/coding-agent.json
 * @returns {{ path: string, action: "created" | "materialized" | "exists", cfg: Record<string, any> }}
 */
export function ensureCodingAgentJsonRealFile(agentPath, templatePath) {
  fs.mkdirSync(path.dirname(agentPath), { recursive: true });

  let stat = null;
  try {
    stat = fs.lstatSync(agentPath);
  } catch {
    stat = null;
  }

  if (stat?.isSymbolicLink()) {
    const raw = fs.readFileSync(agentPath, "utf8");
    const cfg = JSON.parse(raw);
    fs.unlinkSync(agentPath);
    fs.writeFileSync(agentPath, `${JSON.stringify(cfg, null, 2)}\n`);
    return { path: agentPath, action: "materialized", cfg };
  }

  if (stat?.isFile()) {
    const cfg = JSON.parse(fs.readFileSync(agentPath, "utf8"));
    return { path: agentPath, action: "exists", cfg };
  }

  let cfg;
  if (fs.existsSync(templatePath) && fs.statSync(templatePath).isFile()) {
    cfg = JSON.parse(fs.readFileSync(templatePath, "utf8"));
  } else {
    cfg = {
      serverMode: "self-hosted",
      apiUrl: "http://127.0.0.1:8888",
      optInOnly: true,
      optInPaths: [],
      mapPathToBank: {},
      notebooklmAccess: { enabled: false, banks: ["*"] },
    };
  }
  fs.writeFileSync(agentPath, `${JSON.stringify(cfg, null, 2)}\n`);
  return { path: agentPath, action: "created", cfg };
}

/**
 * Set notebooklmAccess.enabled on a real coding-agent.json. Never writes templatePath.
 * Materializes a symlink into a regular file first when needed.
 *
 * @param {string} agentPath
 * @param {string} templatePath
 * @param {boolean} enabled
 * @param {{ dry?: boolean }} [opts]
 * @returns {{ dry?: boolean, action?: string, agentPath: string, enabled: boolean, wrote: boolean }}
 */
export function setNotebooklmAccessEnabled(agentPath, templatePath, enabled, opts = {}) {
  const absTemplate = path.resolve(templatePath);
  if (opts.dry) {
    return {
      dry: true,
      agentPath,
      enabled,
      wrote: false,
      action: fs.existsSync(agentPath)
        ? fs.lstatSync(agentPath).isSymbolicLink()
          ? "would-materialize"
          : "would-update"
        : "would-create",
    };
  }

  const { cfg, action } = ensureCodingAgentJsonRealFile(agentPath, templatePath);
  // Guard: never write into the shipped template even if agentPath somehow resolves there.
  if (path.resolve(agentPath) === absTemplate) {
    throw new Error(`refusing to write notebooklmAccess into shipped template ${templatePath}`);
  }
  const access =
    cfg.notebooklmAccess && typeof cfg.notebooklmAccess === "object" ? { ...cfg.notebooklmAccess } : {};
  access.enabled = enabled === true;
  if (!Array.isArray(access.banks) || !access.banks.length) access.banks = ["*"];
  cfg.notebooklmAccess = access;
  fs.writeFileSync(agentPath, `${JSON.stringify(cfg, null, 2)}\n`);
  return { agentPath, enabled: access.enabled, wrote: true, action };
}
