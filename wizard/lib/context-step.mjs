import { spawnSync } from "node:child_process";
import { CONTEXT_PROXY_SERVICE, contextProxyRunning, prepareContextProxyFiles } from "../../cli/context-management.mjs";
import { agentsPointedAtContextProxy } from "../../cli/coding-agent/install-context-proxy.mjs";
import { act } from "./exec.mjs";
import { composeArgs, composeSpawnOptions } from "./compose.mjs";
import { info, ok, step, warn } from "./log.mjs";
import { confirm } from "./prompts.mjs";
import { contextProxyFromPmConfig, updatePmConfigTable } from "./pm-config.mjs";

/**
 * Wizard step "Context management (smart compaction)": ask on/off, save `[context_proxy] enabled`
 * (syncPmConfig keeps the table when it rewrites config.toml), and start or stop the compose
 * `context-proxy` service. install-coding-agent reads the saved value when the next step wires agents.
 */

export const CONTEXT_STEP_TITLE = "Context management (smart compaction)";

/** The saved choice: `[context_proxy] enabled` in the merged config, default off. */
export function contextManagementFromConfig(ctx) {
  return contextProxyFromPmConfig(ctx.pmMerged || {}).enabled;
}

/** Context with the context-proxy profile added, for compose calls on that service. */
function withProxyProfile(ctx) {
  return { ...ctx, extraComposeProfiles: [...(ctx.extraComposeProfiles || []), CONTEXT_PROXY_SERVICE] };
}

/**
 * Ask on/off (default: the saved value, else off) and save the answer when it differs from config.
 * @param {import("./run-wizard.mjs").WizardContext} ctx
 * @param {string} number step number shown in the title
 * @returns {Promise<boolean>}
 */
export async function chooseContextManagement(ctx, number) {
  step(`${number}. ${CONTEXT_STEP_TITLE}`);
  info("Trims long agent sessions into a local saved log; agents search the saved turns with smart_compact_search.");
  info("Claude Code and OpenCode 1 go through the local context-proxy compose service; OpenCode 2 uses its native plugin.");
  const current = contextManagementFromConfig(ctx);
  const on = await confirm(ctx, "Turn context management on?", current ? "y" : "n");
  ctx.contextManagement = on;
  const saved = ctx.pmMerged?.context_proxy?.enabled;
  if (saved !== on) {
    const r = updatePmConfigTable(ctx.home, "context_proxy", { enabled: on }, { dry: ctx.dry });
    info(`${r === "dry-run" ? "[dry-run] would save" : "saved"} [context_proxy] enabled = ${on}`);
    if (r !== "dry-run") {
      ctx.pmMerged = { ...(ctx.pmMerged || {}), context_proxy: { ...(ctx.pmMerged?.context_proxy || {}), enabled: on } };
    }
  }
  ok(`context management ${on ? "on" : "off"}`);
  return on;
}

/**
 * Start the service when on (before agents are pointed at it). Writes the key file and store
 * directories compose needs first.
 * @param {import("./run-wizard.mjs").WizardContext} ctx
 */
export async function startContextProxy(ctx) {
  if (!(ctx.contextManagement ?? contextManagementFromConfig(ctx))) return;
  if (!ctx.dry) prepareContextProxyFiles(ctx.home);
  const c = withProxyProfile(ctx);
  const up = composeArgs(c, "up", "-d", "--no-build", CONTEXT_PROXY_SERVICE);
  await act(ctx, `docker ${up.join(" ")}`, "docker", up, composeSpawnOptions(c));
  if (!ctx.dry) ok("context-proxy started");
}

/**
 * Stop the service when off and it runs, unless an agent still points at it (stopping would
 * break that agent's every request).
 * @param {import("./run-wizard.mjs").WizardContext} ctx
 * @param {typeof spawnSync} [spawn]
 */
export async function stopContextProxy(ctx, spawn = spawnSync) {
  if (ctx.contextManagement ?? contextManagementFromConfig(ctx)) return;
  const c = withProxyProfile(ctx);
  if (!contextProxyRunning(composeArgs(c), composeSpawnOptions(c), spawn)) return;
  const pointed = ctx.dry ? [] : agentsPointedAtContextProxy(ctx.home);
  if (pointed.length) {
    warn(`context-proxy left running: ${pointed.join(", ")} still point at it. Run: npx @bcmyguest/openmem context off`);
    return;
  }
  const stop = composeArgs(c, "stop", CONTEXT_PROXY_SERVICE);
  await act(ctx, `docker ${stop.join(" ")}`, "docker", stop, composeSpawnOptions(c));
  if (!ctx.dry) ok("context-proxy stopped");
}
