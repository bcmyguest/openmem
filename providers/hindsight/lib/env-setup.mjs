/**
 * Step "4. Secrets and env", Hindsight half: ~/.config/hindsight/hindsight.env from the
 * shipped example, then the stack setup script (litellm.env, .env, compose.override.yaml),
 * then wiring hindsight.env to the LiteLLM proxy.
 */
import fs from "node:fs";
import path from "node:path";
import { ensureState } from "./state.mjs";

/** @typedef {import("../../../wizard/lib/provider-wizard/helpers.mjs").ProviderWizardHelpers} Helpers */

/**
 * True when hindsight.env points Hindsight at the LiteLLM proxy with the master key.
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export function llmWired(ctx, h) {
  if (h.envValue(ctx.envFile, "HINDSIGHT_API_LLM_BASE_URL") !== "http://litellm:4000/v1") {
    return false;
  }
  const key = h.envValue(ctx.envFile, "HINDSIGHT_API_LLM_API_KEY");
  const master = h.envValue(ctx.litellmEnv, "LITELLM_MASTER_KEY");
  return Boolean(key && master && key === master);
}

/**
 * Arguments for the meta wizard's stack setup script.
 * @param {Record<string, any>} ctx
 */
export function stackEnv(ctx) {
  ensureState(ctx);
  let backend = ctx.backend;
  if (backend === "custom") backend = "lemond";
  /** @type {Record<string, string>} */
  const env = { MEMORY_BACKEND: backend };
  if (ctx.ollamaInCompose) env.MEMORY_OLLAMA_IN_COMPOSE = "1";
  return {
    description:
      "scripts/setup.sh: write .env, litellm.env (mode 600 when new), compose.override.yaml",
    env,
  };
}

/**
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export async function setupEnv(ctx, h) {
  ensureState(ctx);
  const example = path.join(ctx.repoRoot, "config/hindsight.env.example");
  if (fs.existsSync(ctx.envFile)) h.ok(`kept ${ctx.envFile}`);
  else if (ctx.dry) h.info(`[dry-run] create ${ctx.envFile} from config/hindsight.env.example (mode 600)`);
  else {
    fs.copyFileSync(example, ctx.envFile);
    fs.chmodSync(ctx.envFile, 0o600);
    h.ok(`created ${ctx.envFile} (mode 600)`);
  }
  await h.runStackSetup(ctx);
  if (ctx.dry) {
    h.info(
      `[dry-run] run setup.sh --migrate-env unless ${ctx.envFile} already uses the LiteLLM proxy and master key`,
    );
  } else if (llmWired(ctx, h)) h.ok("Hindsight calls the LiteLLM proxy with the master key");
  else if (await h.confirm(ctx, `Point ${ctx.envFile} at the LiteLLM proxy now (backs up the file, prints no values)?`, "y")) {
    await h.runStackSetup(ctx, {
      description: "migrate hindsight.env",
      args: ["--migrate-env"],
      env: {},
    });
  } else h.warn("Hindsight is not wired to the LiteLLM proxy; the stack will not work until you migrate");
}
