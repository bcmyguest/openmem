import fs from "node:fs";
import path from "node:path";
import TOML from "@iarna/toml";
import { SILENT, readJson, writeFileAtomic, writeJson } from "./file-io.mjs";
import { removeTomlPath } from "./toml-edit.mjs";

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

/** True when an MCP server entry launches the upstream package's mcp-server.js. */
export function isUpstreamMcpEntry(entry) {
  if (!entry || typeof entry !== "object" || entry.command !== "node" || !Array.isArray(entry.args)) return false;
  return typeof entry.args[0] === "string" && UPSTREAM_MCP_SCRIPT.test(entry.args[0].replaceAll("\\", "/"));
}

function readJsonFile(file, h) {
  if (!fs.existsSync(file)) return null;
  try {
    return readJson(file);
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
  // Claude Code rewrites ~/.claude.json while it runs; replace it in one rename.
  writeJson(file, config);
  h.ok(`${agentId}: removed upstream Hindsight MCP server "${UPSTREAM_MCP_NAME}" from ${file}`);
  return true;
}

/**
 * Codex `[mcp_servers.hindsight]` (with subtables), an inline `hindsight = {…}` under
 * `[mcp_servers]`, or dotted keys, in ~/.codex/config.toml. Only that entry's text is removed;
 * the result must re-parse without the entry, else the file is left untouched.
 */
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
  let next;
  try {
    next = removeTomlPath(text, ["mcp_servers", UPSTREAM_MCP_NAME]);
    if (TOML.parse(next)?.mcp_servers?.[UPSTREAM_MCP_NAME] !== undefined) throw new Error("entry still present after the edit");
  } catch (err) {
    h.warn(`codex: left ${file} unchanged; remove [mcp_servers.${UPSTREAM_MCP_NAME}] by hand (${err.message})`);
    return false;
  }
  if (dry) {
    h.info(`[dry-run] remove upstream Hindsight codex MCP server [mcp_servers.${UPSTREAM_MCP_NAME}] from ${file}`);
    return true;
  }
  writeFileAtomic(file, next);
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
