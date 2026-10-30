import { spawnSync } from "node:child_process";
import {
  CONTEXT_PROXY_SERVICE,
  contextProxyRunning,
  prepareContextProxyFiles,
  proxyServiceNeeded,
} from "../../cli/context-management.mjs";
import { agentsPointedAtContextProxy } from "../../cli/coding-agent/install-context-proxy.mjs";
import { act } from "./exec.mjs";
import { composeArgs, composeSpawnOptions } from "./compose.mjs";
import { info, ok, step, warn } from "./log.mjs";
import { multiselect } from "./prompts.mjs";
import { CONTEXT_AGENT_KEYS, contextAgentsFromPmConfig, updatePmConfigContextAgents } from "./pm-config.mjs";

/**
 * Wizard step "Context management (smart compaction)": pick the installed agents to trim, save
 * `[context_proxy.agents]` and `[context_proxy] enabled` (syncPmConfig keeps the table when it rewrites
 * config.toml), and start or stop the compose `context-proxy` service. install-coding-agent reads the
 * saved values when the next step wires agents.
 */

export const CONTEXT_STEP_TITLE = "Context management (smart compaction)";
/** Agents the step offers. */
const SELECTABLE = ["claude-code", "opencode1", "codex", "opencode2"];
const LABELS = {
  "claude-code": "Claude Code (context-proxy service)",
  opencode1: "OpenCode 1 (context-proxy service)",
  codex: "Codex (context-proxy service, ChatGPT login)",
  opencode2: "OpenCode 2 (native plugin, no service)",
};

/**
 * Config keys for detected harnesses (`claude-code`, `codex`, `opencode`, `cursor-cli`).
 * @param {string[]} harnesses
 * @param {number} opencodeMajor
 */
export function contextAgentKeys(harnesses, opencodeMajor) {
  const keys = [];
  if (harnesses.includes("claude-code")) keys.push("claude-code");
  if (harnesses.includes("codex")) keys.push("codex");
  if (harnesses.includes("opencode")) keys.push(opencodeMajor >= 2 ? "opencode2" : "opencode1");
  return keys;
}

/**
 * Defaults: a saved per-agent key, else a saved `enabled`, else OpenCode 2 on and the proxy-routed agents off.
 * @param {Record<string, unknown>} cfg
 * @returns {Record<string, boolean>}
 */
export function contextAgentDefaults(cfg) {
  return contextAgentsFromPmConfig(cfg).agents;
}

/** Whether the proxy service is needed: the step's choice, else the saved config. */
export function contextServiceWanted(ctx) {
  return proxyServiceNeeded(ctx.contextAgents || contextAgentsFromPmConfig(ctx.pmMerged || {}).agents);
}

/** Context with the context-proxy profile added, for compose calls on that service. */
function withProxyProfile(ctx) {
  return { ...ctx, extraComposeProfiles: [...(ctx.extraComposeProfiles || []), CONTEXT_PROXY_SERVICE] };
}

/**
 * Multi-select the installed agents (defaults: contextAgentDefaults) and save the values when they differ
 * from config. Agents that are not installed keep their saved value, else their default.
 * @param {import("./run-wizard.mjs").WizardContext} ctx
 * @param {string} number step number shown in the title
 * @param {string[]} installed config keys of the installed agents (contextAgentKeys)
 * @returns {Promise<Record<string, boolean>>}
 */
export async function chooseContextManagement(ctx, number, installed) {
  step(`${number}. ${CONTEXT_STEP_TITLE}`);
  info("Stores every session message in a local SQLite store and trims long sessions; agents query the trimmed turns with smart_compact_search and smart_compact_sql.");
  info("Claude Code, OpenCode 1 and Codex go through the local context-proxy compose service; OpenCode 2 uses its native plugin.");
  const cfg = ctx.pmMerged || {};
  const { agents: current, saved } = contextAgentsFromPmConfig(cfg);
  const defaults = contextAgentDefaults(cfg);
  const offered = SELECTABLE.filter((k) => installed.includes(k));
  let values;
  if (!offered.length) {
    info("no agent that supports context management is installed; saved values kept");
    values = current;
  } else {
    const picked = await multiselect(
      ctx,
      "Trim long sessions for which agents?",
      offered.map((k) => ({ value: k, label: LABELS[k] })),
      offered.filter((k) => defaults[k]),
    );
    values = Object.fromEntries(CONTEXT_AGENT_KEYS.map((k) => [k, offered.includes(k) ? picked.includes(k) : (saved.includes(k) ? current[k] : defaults[k])]));
    const changed = CONTEXT_AGENT_KEYS.some((k) => !saved.includes(k) || current[k] !== values[k]);
    if (changed) {
      const r = updatePmConfigContextAgents(ctx.home, values, { dry: ctx.dry });
      const summary = CONTEXT_AGENT_KEYS.map((k) => `${k} = ${values[k]}`).join(", ");
      info(`${r.result === "dry-run" ? "[dry-run] would save" : "saved"} [context_proxy.agents] ${summary}`);
      if (r.result !== "dry-run") {
        const table = { ...(cfg.context_proxy || {}), enabled: r.enabled, agents: r.agents };
        ctx.pmMerged = { ...cfg, context_proxy: table };
      }
    }
  }
  ctx.contextAgents = values;
  ok(`context management: ${CONTEXT_AGENT_KEYS.map((k) => `${k} ${values[k] ? "on" : "off"}`).join(", ")}`);
  return values;
}

/**
 * Start the service when a proxy-routed agent is on (before agents are pointed at it). Writes the key file
 * and store directories compose needs first.
 * @param {import("./run-wizard.mjs").WizardContext} ctx
 */
export async function startContextProxy(ctx) {
  if (!contextServiceWanted(ctx)) return;
  if (!ctx.dry) prepareContextProxyFiles(ctx.home);
  const c = withProxyProfile(ctx);
  const up = composeArgs(c, "up", "-d", "--no-build", CONTEXT_PROXY_SERVICE);
  await act(ctx, `docker ${up.join(" ")}`, "docker", up, composeSpawnOptions(c));
  if (!ctx.dry) ok("context-proxy started");
}

/**
 * Stop the service when no proxy-routed agent is on and it runs, unless an agent still points at it
 * (stopping would break that agent's every request).
 * @param {import("./run-wizard.mjs").WizardContext} ctx
 * @param {typeof spawnSync} [spawn]
 */
export async function stopContextProxy(ctx, spawn = spawnSync) {
  if (contextServiceWanted(ctx)) return;
  const c = withProxyProfile(ctx);
  if (!contextProxyRunning(composeArgs(c), composeSpawnOptions(c), spawn)) return;
  const pointed = ctx.dry ? [] : agentsPointedAtContextProxy(ctx.home);
  if (pointed.length) {
    warn(`context-proxy left running: ${pointed.join(", ")} still point at it. Run: npx @bcmyguest/openmem install-coding-agent --yes`);
    return;
  }
  const stop = composeArgs(c, "stop", CONTEXT_PROXY_SERVICE);
  await act(ctx, `docker ${stop.join(" ")}`, "docker", stop, composeSpawnOptions(c));
  if (!ctx.dry) ok("context-proxy stopped");
}
