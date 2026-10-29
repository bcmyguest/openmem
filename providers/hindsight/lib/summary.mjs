/** Hindsight's contribution to the wizard's closing summary. */
import fs from "node:fs";
import { composeCommandText } from "../../../wizard/lib/compose.mjs";
import { MERIDIAN_GUIDE, MERIDIAN_TERMS_URL } from "./meridian.mjs";
import { ensureState } from "./state.mjs";

/**
 * Lines the meta wizard prints in its summary, in the order it prints them.
 * @param {Record<string, any>} ctx
 * @returns {{ running: string[], configFiles: string[], notes: string[], logServices: string[] }}
 */
export function summary(ctx) {
  ensureState(ctx);
  const modelWhere =
    ctx.backend === "ollama" && ctx.ollamaInCompose
      ? "compose Ollama (profile ollama)"
      : "the LiteLLM proxy (internal network)";
  const running = [
    `  Hindsight API      ${ctx.hindsightUrl}  (docs: ${ctx.hindsightUrl}/docs)`,
    `  control plane      http://127.0.0.1:${ctx.portCp}`,
    `  model              ${ctx.backend}, ${ctx.model} via ${modelWhere}`,
  ];
  if (ctx.backend === "meridian") {
    running.push(`  reflect model      ${ctx.reflectModel || ctx.model}`);
    running.push(
      `  Meridian           ${ctx.meridianBase || "(host URL not recorded)"} on the host (not managed by setup; LiteLLM calls ${ctx.apiBase})`,
    );
  }
  if (ctx.ollamaInCompose) {
    running.push(`  Ollama            http://127.0.0.1:11434 (compose service; LiteLLM uses http://ollama:11434)`);
  }
  const configFiles = [`  ${ctx.envFile}`];
  if (fs.existsSync(ctx.litellmOverride)) {
    configFiles.push(`  ${ctx.litellmOverride} (model routes; replaces config/litellm.*.yaml)`);
  } else if (ctx.backend === "custom" || ctx.backend === "meridian") {
    configFiles.push(`  ${ctx.litellmOverride} (missing: ${ctx.backend} backend needs it)`);
  } else configFiles.push(`  config/litellm.${ctx.backend}.yaml (shipped routes)`);
  const litellmUp = composeCommandText(ctx, "up", "-d", "litellm");
  const notes = [
    `Control plane (banks, ops, LLM queue): http://127.0.0.1:${ctx.portCp}`,
    `Reflect needs a capable model (memory-reflect alias). On a weak or remote LLM, edit ${ctx.litellmOverride} and point memory-reflect at Meridian, an OpenAI-compatible host, or a stronger local model — then: ${litellmUp}`,
    `Change later: rerun ./setup. For a route-only edit, run: ${litellmUp}`,
  ];
  if (ctx.backend === "meridian") {
    configFiles.push(`  ${ctx.litellmEnv} (MERIDIAN_API_KEY)`);
    notes.push(
      `Meridian must keep running on this host with MERIDIAN_HOST=0.0.0.0 so the LiteLLM container reaches it; see ${MERIDIAN_GUIDE}.`,
      `Claude subscription use through Meridian is governed by Anthropic's Consumer Terms: ${MERIDIAN_TERMS_URL}`,
    );
  }
  if (ctx.smokeFailed) {
    notes.unshift(
      `Smoke retain/recall did not finish — stack is up; fix the model/LLM queue via http://127.0.0.1:${ctx.portCp} then re-run setup or: curl the wizard-smoke retain against ${ctx.hindsightUrl}`,
    );
  }
  return { running, configFiles, notes, logServices: ["hindsight", "litellm"] };
}
