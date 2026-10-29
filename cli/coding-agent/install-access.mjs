import fs from "node:fs";
import path from "node:path";
import TOML from "@iarna/toml";
import { readJson, writeFileAtomic, writeJson } from "./file-io.mjs";
import { mergeOpencodeConfig, opencodeConfigPath } from "./opencode-config.mjs";
import { removeSpans, tomlSpansUnder, tomlStatements } from "./toml-edit.mjs";

const SKILL_TARGETS = {
  "claude-code": ".claude/skills/openmem",
  codex: ".agents/skills/openmem",
  "cursor-cli": ".cursor/skills/openmem",
  opencode: ".config/opencode/skills/openmem",
};

/** Set `features.hooks = true` unless the file sets it (to any value) already. */
function enableCodexHooks(text) {
  const statements = tomlStatements(text);
  if (statements.some((s) => s.kind === "kv" && s.path.length === 2 && s.path[0] === "features" && s.path[1] === "hooks")) return text;
  const at = statements.findIndex((s) => s.kind === "table" && s.path.length === 1 && s.path[0] === "features");
  if (at < 0) return `${text}${text && !text.endsWith("\n") ? "\n" : ""}[features]\nhooks = true\n`;
  let end = statements[at].end;
  for (let k = at + 1; k < statements.length && statements[k].kind === "kv"; k++) end = statements[k].end;
  const head = text.slice(0, end);
  return `${head}${head.endsWith("\n") ? "" : "\n"}hooks = true\n${text.slice(end)}`;
}

/** Codex config with hooks enabled and exactly one current `[mcp_servers.openmem]`; throws on a TOML it cannot edit. */
function updateCodexToml(text, scriptPath, stackRoot) {
  text = enableCodexHooks(text);
  const section = [
    "[mcp_servers.openmem]",
    'command = "node"',
    `args = [${JSON.stringify(scriptPath)}]`,
    "[mcp_servers.openmem.env]",
    `PM_STACK_ROOT = ${JSON.stringify(stackRoot)}`,
  ].join("\n");
  // Drop current openmem blocks and the pre-rebrand personal-memory name.
  const spans = ["openmem", "personal-memory"].flatMap((name) => tomlSpansUnder(text, ["mcp_servers", name]));
  const retained = removeSpans(text, spans).trimEnd();
  const out = `${retained ? `${retained}\n\n` : ""}${section}\n`;
  TOML.parse(out);
  return out;
}

/** Install one shared skill and the unified MCP in each selected agent's global config. */
export function installAgentAccess({ home, runtimeRoot, stackRoot, agents, dry = false, h }) {
  const scriptPath = path.join(runtimeRoot, "cli", "openmem-mcp.mjs");
  const skillSource = path.join(runtimeRoot, ".agents", "skills", "openmem", "SKILL.md");
  for (const agent of agents) {
    const skillRel = SKILL_TARGETS[agent];
    if (!skillRel) continue;
    const skillPath = path.join(home, skillRel, "SKILL.md");
    if (dry) h?.info(`[dry-run] install ${agent} openmem skill → ${skillPath}`);
    else {
      fs.mkdirSync(path.dirname(skillPath), { recursive: true });
      fs.copyFileSync(skillSource, skillPath);
      h?.ok(`${agent} skill → ${skillPath}`);
    }
    if (agent === "cursor-cli") continue; // install-mcp owns ~/.cursor/mcp.json
    if (agent === "codex") {
      const file = path.join(home, ".codex", "config.toml");
      if (dry) h?.info(`[dry-run] merge openmem MCP into ${file}`);
      else {
        const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
        let next;
        try {
          next = updateCodexToml(current, scriptPath, stackRoot);
        } catch (err) {
          h?.warn(`codex: left ${file} unchanged; add [mcp_servers.openmem] by hand (${err.message})`);
          continue;
        }
        writeFileAtomic(file, next);
        h?.ok(`codex MCP → ${file}`);
      }
      continue;
    }
    const file = agent === "claude-code" ? path.join(home, ".claude.json") : opencodeConfigPath(home);
    if (dry) {
      h?.info(`[dry-run] merge openmem MCP into ${file}`);
      continue;
    }
    if (agent === "claude-code") {
      const config = readJson(file);
      const servers = { ...(config.mcpServers || {}) };
      delete servers["personal-memory"];
      servers.openmem = {
        type: "stdio", command: "node", args: [scriptPath], env: { PM_STACK_ROOT: stackRoot },
      };
      config.mcpServers = servers;
      writeJson(file, config);
    } else {
      mergeOpencodeConfig(home, "mcp", (existing) => {
        const next = { ...existing, openmem: {
          type: "local", command: ["node", scriptPath], enabled: true,
          environment: { PM_STACK_ROOT: stackRoot },
        } };
        delete next["personal-memory"];
        return next;
      });
    }
    h?.ok(`${agent} MCP → ${file}`);
  }
}
