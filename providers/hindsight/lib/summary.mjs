/** Hindsight's contribution to the wizard's closing summary. */
import fs from "node:fs";
import { composeCommandText } from "../../../wizard/lib/compose.mjs";
import { ensureState } from "./state.mjs";

/**
 * Lines the meta wizard prints in its summary, in the order it prints them.
 * @param {Record<string, any>} ctx
 * @returns {{ running: string[], configFiles: string[], notes: string[], logServices: string[] }}
 */
export function summary(ctx) {
  ensureState(ctx);
  const running = [
    `  Hindsight API      ${ctx.hindsightUrl}  (docs: ${ctx.hindsightUrl}/docs)`,
    `  control plane      http://127.0.0.1:${ctx.portCp}`,
    `  model              ${ctx.backend}, ${ctx.model} via the LiteLLM proxy (internal network)`,
  ];
  const configFiles = [`  ${ctx.envFile}`];
  if (fs.existsSync(ctx.litellmOverride)) {
    configFiles.push(`  ${ctx.litellmOverride} (model routes; replaces config/litellm.*.yaml)`);
  } else if (ctx.backend === "custom") {
    configFiles.push(`  ${ctx.litellmOverride} (missing: custom backend needs it)`);
  } else configFiles.push(`  config/litellm.${ctx.backend}.yaml (shipped routes)`);
  const litellmUp = composeCommandText(ctx, "up", "-d", "litellm");
  const notes = [
    `Reflect needs a capable model (memory-reflect alias). On a weak or remote LLM, edit ${ctx.litellmOverride} and point memory-reflect at Meridian, an OpenAI-compatible host, or a stronger local model — then: ${litellmUp}`,
    `Change later: rerun ./setup. For a route-only edit, run: ${litellmUp}`,
  ];
  return { running, configFiles, notes, logServices: ["hindsight", "litellm"] };
}
