import fs from "node:fs";
import path from "node:path";
import TOML from "@iarna/toml";

/** Name the upstream @vectorize-io/hindsight-coding-agents installer gives its MCP server. */
const UPSTREAM_MCP_NAME = "hindsight";
/** Directory name of the skill copy the upstream installer writes into each agent's skill root. */
const UPSTREAM_SKILL_NAME = "hindsight-coding-agent";
/** The upstream MCP runs `node <pkg>/dist/mcp-server.js`; pkg is the npx copy or `~/.hindsight/coding-agents`. */
const UPSTREAM_MCP_SCRIPT = /hindsight[-/]coding-agents\/dist\/mcp-server\.js$/;
/** Skill roots the upstream installer uses (its SKILL_DIRS); OpenCode gets no upstream skill or MCP. */
const UPSTREAM_SKILL_ROOTS = {
  "claude-code": [".claude", "skills"],
  codex: [".agents", "skills"],
  "cursor-cli": [".cursor", "skills"],
};
const CODEX_SERVER_HEADER = /^[ \t]*\[[ \t]*mcp_servers[ \t]*\.[ \t]*(?:hindsight|"hindsight"|'hindsight')[ \t]*(?:\.[^\]]*)?\]/;
const SILENT = { info: () => {}, ok: () => {}, warn: () => {} };

/** True when an MCP server entry launches the upstream package's mcp-server.js. */
export function isUpstreamMcpEntry(entry) {
  if (!entry || typeof entry !== "object" || entry.command !== "node" || !Array.isArray(entry.args)) return false;
  return typeof entry.args[0] === "string" && UPSTREAM_MCP_SCRIPT.test(entry.args[0].replaceAll("\\", "/"));
}

function readJsonFile(file, h) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    h.warn(`skipped ${file}: ${err.message}`);
    return null;
  }
}

/** JSON `mcpServers.hindsight` (Claude Code ~/.claude.json, Cursor ~/.cursor/mcp.json). */
function removeJsonMcp({ agentId, file, dry, h }) {
  const config = readJsonFile(file, h);
  if (!isUpstreamMcpEntry(config?.mcpServers?.[UPSTREAM_MCP_NAME])) return false;
  if (dry) {
    h.info(`[dry-run] remove upstream Hindsight ${agentId} MCP server "${UPSTREAM_MCP_NAME}" from ${file}`);
    return true;
  }
  delete config.mcpServers[UPSTREAM_MCP_NAME];
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  h.ok(`${agentId}: removed upstream Hindsight MCP server "${UPSTREAM_MCP_NAME}" from ${file}`);
  return true;
}

/** Codex `[mcp_servers.hindsight]` and its subtables in ~/.codex/config.toml. */
function removeCodexMcp({ file, dry, h }) {
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, "utf8");
  let parsed;
  try {
    parsed = TOML.parse(text);
  } catch (err) {
    h.warn(`skipped ${file}: ${err.message}`);
    return false;
  }
  if (!isUpstreamMcpEntry(parsed?.mcp_servers?.[UPSTREAM_MCP_NAME])) return false;
  if (dry) {
    h.info(`[dry-run] remove upstream Hindsight codex MCP server [mcp_servers.${UPSTREAM_MCP_NAME}] from ${file}`);
    return true;
  }
  const kept = text.split(/(?=^[ \t]*\[)/m).filter((block) => !CODEX_SERVER_HEADER.test(block));
  fs.writeFileSync(file, `${kept.join("").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`);
  h.ok(`codex: removed upstream Hindsight MCP server [mcp_servers.${UPSTREAM_MCP_NAME}] from ${file}`);
  return true;
}

/** `<skill root>/hindsight-coding-agent/` when its SKILL.md declares that name. */
function removeSkill({ agentId, home, dry, h }) {
  const dir = path.join(home, ...UPSTREAM_SKILL_ROOTS[agentId], UPSTREAM_SKILL_NAME);
  const skill = path.join(dir, "SKILL.md");
  if (!fs.existsSync(skill)) return false;
  const front = fs.readFileSync(skill, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!front || !new RegExp(`^name:\\s*["']?${UPSTREAM_SKILL_NAME}["']?\\s*$`, "m").test(front[1])) return false;
  if (dry) {
    h.info(`[dry-run] remove upstream Hindsight ${agentId} skill ${dir}`);
    return true;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  h.ok(`${agentId}: removed upstream Hindsight skill ${dir}`);
  return true;
}

/**
 * Remove the MCP server and skill copies `@vectorize-io/hindsight-coding-agents install` writes.
 * An MCP entry counts only when it is named `hindsight` and runs the upstream mcp-server.js.
 * Returns `{ removed: [{ agent, kind, path }] }`; with `dry` it only reports.
 */
export function removeUpstreamAccess({ home, agents, dry = false, h = SILENT }) {
  const removed = [];
  const note = (agent, kind, file, hit) => hit && removed.push({ agent, kind, path: file });
  for (const agentId of agents) {
    if (agentId === "claude-code" || agentId === "cursor-cli") {
      const file = agentId === "claude-code" ? path.join(home, ".claude.json") : path.join(home, ".cursor", "mcp.json");
      note(agentId, "mcp", file, removeJsonMcp({ agentId, file, dry, h }));
    } else if (agentId === "codex") {
      const file = path.join(home, ".codex", "config.toml");
      note(agentId, "mcp", file, removeCodexMcp({ file, dry, h }));
    }
    if (UPSTREAM_SKILL_ROOTS[agentId]) {
      const dir = path.join(home, ...UPSTREAM_SKILL_ROOTS[agentId], UPSTREAM_SKILL_NAME);
      note(agentId, "skill", dir, removeSkill({ agentId, home, dry, h }));
    }
  }
  return { removed };
}
