/**
 * After the stack is healthy: wait for compose Ollama and pull models the LiteLLM routes need.
 */
import { ollamaModelNames } from "./probe.mjs";
import { ensureState } from "./state.mjs";

/** @typedef {import("../../../wizard/lib/provider-wizard/helpers.mjs").ProviderWizardHelpers} Helpers */

const HOST_TAGS = "http://127.0.0.1:11434/api/tags";

/**
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export async function ensureComposeOllamaModels(ctx, h) {
  ensureState(ctx);
  if (ctx.backend !== "ollama" || !ctx.ollamaInCompose) return;
  if (ctx.dry) {
    h.info(`[dry-run] wait for compose Ollama, pull ${ctx.model}`);
    return;
  }

  h.info("waiting for compose Ollama on 127.0.0.1:11434…");
  let body = null;
  for (let i = 0; i < 45; i++) {
    body = h.curlJson(HOST_TAGS);
    if (body) break;
    if (i > 0 && i % 5 === 0) h.info(`… still waiting for Ollama (${i * 2}s)`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!body) {
    h.warn("compose Ollama did not answer on 127.0.0.1:11434; skip model pull");
    return;
  }
  h.ok("compose Ollama is reachable on 127.0.0.1:11434");

  const present = new Set(ollamaModelNames(body));
  const needed = new Set();
  if (ctx.model) needed.add(ctx.model);
  if (ctx.reflectModel) needed.add(ctx.reflectModel);
  for (const name of needed) {
    if (present.has(name)) {
      h.ok(`Ollama already has ${name}`);
      continue;
    }
    const args = h.composeArgs(ctx, "exec", "-T", "ollama", "ollama", "pull", name);
    await h.act(ctx, `pull ${name} into compose Ollama`, "docker", args, {
      cwd: ctx.repoRoot,
    });
  }
}
