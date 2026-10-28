import fs from "node:fs";
import path from "node:path";
import { mergeOpencodeConfig, opencodeConfigPath } from "./opencode-config.mjs";

const SKILL_TARGETS = {
  "claude-code": ".claude/skills/openmem",
  codex: ".agents/skills/openmem",
  "cursor-cli": ".cursor/skills/openmem",
  opencode: ".config/opencode/skills/openmem",
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
    "[mcp_servers.openmem]",
    'command = "node"',
    `args = [${JSON.stringify(scriptPath)}]`,
    "[mcp_servers.openmem.env]",
    `PM_STACK_ROOT = ${JSON.stringify(stackRoot)}`,
  ].join("\n");
  // Drop current openmem blocks and the pre-rebrand personal-memory name.
  const oldServer =
    /^[ \t]*\[mcp_servers\.(?:openmem|"openmem"|'openmem'|personal-memory|"personal-memory"|'personal-memory')(?:\.(?:env|"env"|'env'))?[ \t]*\]/;
  const retained = text.split(/(?=^[ \t]*\[)/m).filter((block) => !oldServer.test(block));
  return `${retained.join("").trimEnd()}\n\n${section}\n`;
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
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, updateCodexToml(current, scriptPath, stackRoot));
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
