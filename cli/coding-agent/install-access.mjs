import fs from "node:fs";
import path from "node:path";
import { mergeOpencodeConfig, opencodeConfigPath } from "./opencode-config.mjs";

const SKILL_TARGETS = {
  "claude-code": ".claude/skills/personal-memory",
  codex: ".agents/skills/personal-memory",
  "cursor-cli": ".cursor/skills/personal-memory",
  opencode: ".config/opencode/skills/personal-memory",
};

function readJson(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function updateCodexToml(text, scriptPath, stackRoot) {
  const blocks = text.split(/(?=^[ \t]*\[)/m);
  const featureIndex = blocks.findIndex((block) => /^[ \t]*\[features\][ \t]*(?:#.*)?(?:\r?\n|$)/.test(block));
  if (featureIndex < 0) blocks.push(`${text && !text.endsWith("\n") ? "\n" : ""}[features]\nhooks = true\n`);
  else if (!/^hooks\s*=/m.test(blocks[featureIndex])) blocks[featureIndex] = `${blocks[featureIndex].trimEnd()}\nhooks = true\n`;
  text = blocks.join("");
  const section = [
    "[mcp_servers.personal-memory]",
    'command = "node"',
    `args = [${JSON.stringify(scriptPath)}]`,
    "[mcp_servers.personal-memory.env]",
    `PM_STACK_ROOT = ${JSON.stringify(stackRoot)}`,
  ].join("\n");
  const oldServer = /^[ \t]*\[mcp_servers\.(?:personal-memory|"personal-memory"|'personal-memory')(?:\.(?:env|"env"|'env'))?[ \t]*\]/;
  const retained = text.split(/(?=^[ \t]*\[)/m).filter((block) => !oldServer.test(block));
  return `${retained.join("").trimEnd()}\n\n${section}\n`;
}

/** Install one shared skill and the unified MCP in each selected agent's global config. */
export function installAgentAccess({ home, runtimeRoot, stackRoot, agents, dry = false, h }) {
  const scriptPath = path.join(runtimeRoot, "cli", "personal-memory-mcp.mjs");
  const skillSource = path.join(runtimeRoot, "skills", "personal-memory", "SKILL.md");
  for (const agent of agents) {
    const skillRel = SKILL_TARGETS[agent];
    if (!skillRel) continue;
    const skillPath = path.join(home, skillRel, "SKILL.md");
    if (dry) h?.info(`[dry-run] install ${agent} personal-memory skill → ${skillPath}`);
    else {
      fs.mkdirSync(path.dirname(skillPath), { recursive: true });
      fs.copyFileSync(skillSource, skillPath);
      h?.ok(`${agent} skill → ${skillPath}`);
    }
    if (agent === "cursor-cli") continue; // install-mcp owns ~/.cursor/mcp.json
    if (agent === "codex") {
      const file = path.join(home, ".codex", "config.toml");
      if (dry) h?.info(`[dry-run] merge personal-memory MCP into ${file}`);
      else {
        const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, updateCodexToml(current, scriptPath, stackRoot));
        h?.ok(`codex MCP → ${file}`);
      }
      continue;
    }
    const file = agent === "claude-code" ? path.join(home, ".claude.json") : opencodeConfigPath(home);
    if (dry) {
      h?.info(`[dry-run] merge personal-memory MCP into ${file}`);
      continue;
    }
    if (agent === "claude-code") {
      const config = readJson(file);
      config.mcpServers = { ...config.mcpServers, "personal-memory": {
        type: "stdio", command: "node", args: [scriptPath], env: { PM_STACK_ROOT: stackRoot },
      } };
      writeJson(file, config);
    } else {
      mergeOpencodeConfig(home, "mcp", (existing) => ({ ...existing, "personal-memory": {
        type: "local", command: ["node", scriptPath], enabled: true,
        environment: { PM_STACK_ROOT: stackRoot },
      } }));
    }
    h?.ok(`${agent} MCP → ${file}`);
  }
}
