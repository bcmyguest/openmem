import fs from "node:fs";
import path from "node:path";
import { SHIM_AGENT_IDS, SHIM_HARNESSES, SHIM_MARKER } from "./hook-harnesses.mjs";
import { SMART_COMPACT_MARKER, SMART_COMPACT_COMMAND, SMART_COMPACT_SKILL, SMART_COMPACT_SKILL_POLICY } from "./context-store.mjs";
import { SILENT, readJson, writeFileAtomic, writeJson } from "./file-io.mjs";
import { mergeOpencodeConfig, opencodeConfigPath, parseJsonc } from "./opencode-config.mjs";

/** Upstream @vectorize-io/hindsight-coding-agents entries name its package or staged copy. */
const UPSTREAM_MARKER = /hindsight[-/]coding-agents/;
const OPENMEM_PLUGIN = /openmem|personal-memory/;
const OPENMEM_PLUGIN_FILE = "coding-agent/opencode-plugin.mjs";
const OPENMEM_PLUGIN2_DIR = "coding-agent/opencode2-plugin";
/** OpenCode 1 reads `plugin` (file paths); OpenCode 2 reads `plugins` (directory paths). */
const OPENCODE_PLUGIN_KEYS = ["plugin", "plugins"];

function hookCommand(root, harnessId, phase) {
  return `node ${JSON.stringify(path.join(root, "cli", "coding-agent", "hook-runner.mjs"))} ${harnessId} ${phase}`;
}

function nestedHookBlock(root, harnessId, phase, timeout) {
  return {
    hooks: [{ type: "command", command: hookCommand(root, harnessId, phase), timeout }],
  };
}

function mergeNestedHooks(existing, root, harnessId, spec) {
  const hooks = existing && typeof existing === "object" ? { ...existing } : {};
  for (const [phase, meta] of Object.entries(spec.events)) {
    const list = Array.isArray(hooks[meta.hook]) ? hooks[meta.hook].filter((e) => !JSON.stringify(e).includes(SHIM_MARKER)) : [];
    hooks[meta.hook] = [...list, nestedHookBlock(root, harnessId, phase, meta.timeout)];
  }
  return hooks;
}

function mergeFlatHooks(existing, root, harnessId, spec) {
  const hooks = existing && typeof existing === "object" ? { ...existing } : {};
  for (const [phase, meta] of Object.entries(spec.events)) {
    const list = Array.isArray(hooks[meta.hook]) ? hooks[meta.hook].filter((e) => !String(e?.command).includes(SHIM_MARKER)) : [];
    hooks[meta.hook] = [
      ...list,
      { command: hookCommand(root, harnessId, phase), timeout: meta.timeout },
    ];
  }
  return hooks;
}

/** Drop matching entries from every event list; empty lists are deleted. Returns true on change. */
function stripHookEntries(hooks, matches) {
  if (!hooks || typeof hooks !== "object") return false;
  let changed = false;
  for (const [event, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) continue;
    const kept = list.filter((e) => !matches(JSON.stringify(e)));
    if (kept.length === list.length) continue;
    changed = true;
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  return changed;
}

export function smartCompactCommandPath(home) {
  return path.join(home, ".claude", "commands", "smart-compact.md");
}

export function smartCompactSkillDir(home) {
  return path.join(home, ".agents", "skills", "smart-compact");
}

const entryText = (entry) => (typeof entry === "string" ? entry : JSON.stringify(entry));

/**
 * Remove matching entries from OpenCode's `plugin` (v1) and `plugins` (v2) lists; a file or key
 * with nothing to remove is left untouched. Returns true on change.
 */
function stripOpencodePlugins(home, matches, keys = OPENCODE_PLUGIN_KEYS) {
  const file = opencodeConfigPath(home);
  if (!fs.existsSync(file)) return false;
  let changed = false;
  for (const key of keys) {
    const list = parseJsonc(fs.readFileSync(file, "utf8"))?.[key];
    if (!Array.isArray(list) || !list.some((p) => matches(entryText(p)))) continue;
    mergeOpencodeConfig(home, key, (existing) => existing.filter((p) => !matches(entryText(p))));
    changed = true;
  }
  return changed;
}

/** Remove hook entries whose JSON text satisfies `matches` from each agent's hook config. */
function removeHooks({ home, agents, dry, h, matches, label }) {
  const removed = [];
  for (const agentId of agents) {
    if (agentId === "opencode") {
      if (dry) h.info(`[dry-run] remove ${label} opencode plugin entries from ${opencodeConfigPath(home)}`);
      else if (stripOpencodePlugins(home, matches)) {
        h.ok(`opencode: removed ${label} plugin entries`);
        removed.push(agentId);
      }
      continue;
    }
    const spec = SHIM_HARNESSES[agentId];
    if (!spec) continue;
    const cfgPath = spec.settingsPath(home);
    if (dry) {
      h.info(`[dry-run] remove ${label} ${agentId} hooks from ${cfgPath}`);
      continue;
    }
    if (!fs.existsSync(cfgPath)) continue;
    const prev = readJson(cfgPath);
    // Older OpenMem installs wrote Cursor events at the top level; check both places.
    const nestedChanged = stripHookEntries(prev.hooks, matches);
    const topChanged = spec.configStyle === "flat" && stripHookEntries(prev, matches);
    if (!nestedChanged && !topChanged) continue;
    writeJson(cfgPath, prev);
    h.ok(`${agentId}: removed ${label} hooks from ${cfgPath}`);
    removed.push(agentId);
  }
  return { removed };
}

/**
 * @param {{ home: string, repoRoot: string, agents: string[], dry: boolean, opencodeMajor?: number, h?: { info: Function, ok: Function, warn: Function } }} opts
 */
export function installSessionShim(opts) {
  const home = opts.home;
  const h = opts.h || SILENT;
  const agents = opts.agents.filter((id) => SHIM_AGENT_IDS.includes(id) || id === "opencode");
  const opencodeV2 = (opts.opencodeMajor || 1) >= 2;
  const opencodePlugin = opencodeV2
    ? path.join(opts.repoRoot, "cli", "coding-agent", "opencode2-plugin")
    : path.join(opts.repoRoot, "cli", "coding-agent", "opencode-plugin.mjs");
  const opencodeKey = opencodeV2 ? "plugins" : "plugin";
  if (!agents.length) {
    h.warn("no agents selected for session shim (claude-code, codex, cursor-cli, opencode)");
    return { installed: [] };
  }

  const installed = [];
  for (const agentId of agents) {
    if (agentId === "opencode") {
      const cfgPath = opencodeConfigPath(home);
      if (opts.dry) {
        h.info(`[dry-run] register opencode ${opencodeV2 ? "2" : "1"} plugin ${opencodePlugin} in ${cfgPath} ("${opencodeKey}")`);
      } else {
        // Remove the other major version's entry so exactly one OpenMem plugin loads.
        stripOpencodePlugins(home, (text) => OPENMEM_PLUGIN.test(text), OPENCODE_PLUGIN_KEYS.filter((k) => k !== opencodeKey));
        mergeOpencodeConfig(home, opencodeKey, (existing) => {
          const plugins = Array.isArray(existing)
            ? existing.filter((p) => !OPENMEM_PLUGIN.test(entryText(p)))
            : [];
          return [...plugins, opencodePlugin];
        });
        h.ok(`opencode: registered openmem ${opencodeV2 ? "OpenCode 2 " : ""}plugin in ${cfgPath}`);
      }
      installed.push("opencode");
      continue;
    }
    const spec = SHIM_HARNESSES[agentId];
    if (!spec) continue;
    const cfgPath = spec.settingsPath(home);
    if (opts.dry) {
      h.info(`[dry-run] merge ${agentId} hooks in ${cfgPath}`);
      if (agentId === "claude-code") h.info(`[dry-run] install /smart-compact command → ${smartCompactCommandPath(home)}`);
      if (agentId === "codex") h.info(`[dry-run] install $smart-compact skill → ${smartCompactSkillDir(home)}`);
      installed.push(agentId);
      continue;
    }
    const prev = readJson(cfgPath);
    if (spec.configStyle === "nested") {
      prev[spec.rootKey] = mergeNestedHooks(prev[spec.rootKey], opts.repoRoot, agentId, spec);
    } else {
      stripHookEntries(prev, (text) => text.includes(SHIM_MARKER));
      prev.version ??= 1;
      prev[spec.rootKey] = mergeFlatHooks(prev[spec.rootKey], opts.repoRoot, agentId, spec);
    }
    writeJson(cfgPath, prev);
    h.ok(`${agentId}: session hooks → ${cfgPath}`);
    if (agentId === "claude-code") {
      const command = smartCompactCommandPath(home);
      writeFileAtomic(command, SMART_COMPACT_COMMAND);
      h.ok(`claude-code: /smart-compact command → ${command}`);
    }
    if (agentId === "codex") {
      const dir = smartCompactSkillDir(home);
      writeFileAtomic(path.join(dir, "SKILL.md"), SMART_COMPACT_SKILL);
      writeFileAtomic(path.join(dir, "agents", "openai.yaml"), SMART_COMPACT_SKILL_POLICY);
      h.ok(`codex: $smart-compact skill → ${dir}`);
    }
    installed.push(agentId);
  }
  return { installed };
}

/** Remove OpenMem's session hooks, OpenCode plugin entry, /smart-compact command and Codex $smart-compact skill. */
export function removeSessionShim({ home, agents, dry = false, h = SILENT }) {
  const out = removeHooks({
    home, agents, dry, h, label: "openmem",
    matches: (text) => text.includes(SHIM_MARKER) || text.includes(OPENMEM_PLUGIN_FILE) || text.includes(OPENMEM_PLUGIN2_DIR),
  });
  const command = smartCompactCommandPath(home);
  if (agents.includes("claude-code") && !dry && fs.existsSync(command)
    && fs.readFileSync(command, "utf8").includes(SMART_COMPACT_MARKER)) {
    fs.rmSync(command);
    h.ok(`claude-code: removed ${command}`);
  }
  const skill = smartCompactSkillDir(home);
  const skillFile = path.join(skill, "SKILL.md");
  if (agents.includes("codex") && !dry && fs.existsSync(skillFile)
    && fs.readFileSync(skillFile, "utf8").includes(SMART_COMPACT_MARKER)) {
    fs.rmSync(skill, { recursive: true, force: true });
    h.ok(`codex: removed ${skill}`);
  }
  return out;
}

/** Remove the upstream Hindsight coding-agent hooks (and its OpenCode plugin entry). */
export function removeUpstreamHooks({ home, agents, dry = false, h = SILENT }) {
  return removeHooks({ home, agents, dry, h, label: "upstream Hindsight", matches: (text) => UPSTREAM_MARKER.test(text) });
}
