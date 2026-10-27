import fs from "node:fs";
import path from "node:path";
import { SHIM_AGENT_IDS, SHIM_HARNESSES, SHIM_MARKER } from "./hook-harnesses.mjs";
import { mergeOpencodeConfig, opencodeConfigPath } from "./opencode-config.mjs";

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

function readJson(pathname) {
  if (!fs.existsSync(pathname)) return {};
  return JSON.parse(fs.readFileSync(pathname, "utf8"));
}

function writeJson(pathname, data) {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * @param {{ home: string, repoRoot: string, agents: string[], dry: boolean, h?: { info: Function, ok: Function, warn: Function } }} opts
 */
export function installSessionShim(opts) {
  const home = opts.home;
  const h = opts.h || { info: () => {}, ok: () => {}, warn: () => {} };
  const agents = opts.agents.filter((id) => SHIM_AGENT_IDS.includes(id) || id === "opencode");
  const opencodePlugin = path.join(opts.repoRoot, "cli", "coding-agent", "opencode-plugin.mjs");
  if (!agents.length) {
    h.warn("no agents selected for session shim (claude-code, codex, cursor-cli, opencode)");
    return { installed: [] };
  }

  const installed = [];
  for (const agentId of agents) {
    if (agentId === "opencode") {
      const cfgPath = opencodeConfigPath(home);
      if (opts.dry) {
        h.info(`[dry-run] register opencode plugin ${opencodePlugin} in ${cfgPath}`);
      } else {
        mergeOpencodeConfig(home, "plugin", (existing) => {
          const plugins = Array.isArray(existing) ? existing.filter((p) => !String(p).includes("personal-memory")) : [];
          return [...plugins, opencodePlugin];
        });
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
      prev[spec.rootKey] = mergeNestedHooks(prev[spec.rootKey], opts.repoRoot, agentId, spec);
    } else {
      Object.assign(prev, mergeFlatHooks(prev, opts.repoRoot, agentId, spec));
    }
    writeJson(cfgPath, prev);
    h.ok(`${agentId}: session hooks → ${cfgPath}`);
    installed.push(agentId);
  }
  return { installed };
}
