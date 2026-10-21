import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SHIM_AGENT_IDS, SHIM_HARNESSES, SHIM_MARKER } from "./hook-harnesses.mjs";

const HOOK_RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), "hook-runner.mjs");
const OPENCODE_PLUGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "opencode-plugin");

function hookCommand(harnessId, phase) {
  return `node ${JSON.stringify(HOOK_RUNNER)} ${harnessId} ${phase}`;
}

function nestedHookBlock(harnessId, phase, timeout) {
  return {
    hooks: [{ type: "command", command: hookCommand(harnessId, phase), timeout }],
  };
}

function mergeNestedHooks(existing, harnessId, spec) {
  const hooks = existing && typeof existing === "object" ? { ...existing } : {};
  for (const [phase, meta] of Object.entries(spec.events)) {
    const list = Array.isArray(hooks[meta.hook]) ? hooks[meta.hook].filter((e) => !JSON.stringify(e).includes(SHIM_MARKER)) : [];
    hooks[meta.hook] = [...list, nestedHookBlock(harnessId, phase, meta.timeout)];
  }
  return hooks;
}

function mergeFlatHooks(existing, harnessId, spec) {
  const hooks = existing && typeof existing === "object" ? { ...existing } : {};
  for (const [phase, meta] of Object.entries(spec.events)) {
    const list = Array.isArray(hooks[meta.hook]) ? hooks[meta.hook].filter((e) => !String(e?.command).includes(SHIM_MARKER)) : [];
    hooks[meta.hook] = [
      ...list,
      { command: hookCommand(harnessId, phase), timeout: meta.timeout },
    ];
  }
  return hooks;
}

function readJson(pathname) {
  if (!fs.existsSync(pathname)) return {};
  return JSON.parse(fs.readFileSync(pathname, "utf8"));
}

function writeJson(pathname, data) {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, `${JSON.stringify(data, null, 2)}\n`);
}

function opencodeConfigPath(home) {
  const dir = path.join(home, ".config", "opencode");
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return path.join(dir, "opencode.json");
}

/** Strip // comments for minimal jsonc merge (opencode). */
function parseJsonc(text) {
  const stripped = text.replace(/^\s*\/\/.*$/gm, "");
  return JSON.parse(stripped);
}

function writeJsoncPlugin(pathname, pluginPath) {
  let cfg = {};
  if (fs.existsSync(pathname)) cfg = parseJsonc(fs.readFileSync(pathname, "utf8"));
  const plugins = Array.isArray(cfg.plugin) ? cfg.plugin.filter((p) => !String(p).includes("personal-memory")) : [];
  plugins.push(pluginPath);
  cfg.plugin = plugins;
  writeJson(pathname, cfg);
}

/**
 * @param {{ home: string, repoRoot: string, agents: string[], dry: boolean, h?: { info: Function, ok: Function, warn: Function } }} opts
 */
export function installSessionShim(opts) {
  const home = opts.home;
  const h = opts.h || { info: () => {}, ok: () => {}, warn: () => {} };
  const agents = opts.agents.filter((id) => SHIM_AGENT_IDS.includes(id) || id === "opencode");
  if (!agents.length) {
    h.warn("no agents selected for session shim (claude-code, codex, cursor-cli, opencode)");
    return { installed: [] };
  }

  const installed = [];
  for (const agentId of agents) {
    if (agentId === "opencode") {
      const cfgPath = opencodeConfigPath(home);
      if (opts.dry) {
        h.info(`[dry-run] register opencode plugin ${OPENCODE_PLUGIN} in ${cfgPath}`);
      } else {
        writeJsoncPlugin(cfgPath, OPENCODE_PLUGIN);
        h.ok(`opencode: registered personal-memory plugin in ${cfgPath}`);
      }
      installed.push("opencode");
      continue;
    }
    const spec = SHIM_HARNESSES[agentId];
    if (!spec) continue;
    const cfgPath = spec.settingsPath(home);
    if (opts.dry) {
      h.info(`[dry-run] merge ${agentId} hooks in ${cfgPath}`);
      installed.push(agentId);
      continue;
    }
    const prev = readJson(cfgPath);
    if (spec.configStyle === "nested") {
      prev[spec.rootKey] = mergeNestedHooks(prev[spec.rootKey], agentId, spec);
    } else {
      Object.assign(prev, mergeFlatHooks(prev, agentId, spec));
    }
    writeJson(cfgPath, prev);
    h.ok(`${agentId}: session hooks → ${cfgPath}`);
    installed.push(agentId);
  }
  return { installed };
}
