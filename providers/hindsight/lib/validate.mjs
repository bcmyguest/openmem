/**
 * Hindsight checks that run after the meta wizard's provider-neutral validation:
 * wizard.conf backend keys, hindsight.env, litellm.env, the LiteLLM wiring, the stack
 * .env's Hindsight keys, and a model override for a non-shipped model.
 */
import fs from "node:fs";
import path from "node:path";
import { ensureState } from "./state.mjs";

/** @typedef {import("../../../wizard/lib/provider-wizard/helpers.mjs").ProviderWizardHelpers} Helpers */

/**
 * Appends to ctx.validationErrors and ctx.validationChecks.
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export function validateHindsight(ctx, h) {
  ensureState(ctx);
  const errors = (ctx.validationErrors ||= []);
  const checks = (ctx.validationChecks ||= []);
  const conf = (key) => h.envValue(ctx.wizardConf, key);

  if (fs.existsSync(ctx.wizardConf)) {
    for (const key of ["MEMORY_BACKEND", "MEMORY_MODEL"]) {
      if (!conf(key)) errors.push(`wizard.conf missing ${key}`);
      else checks.push(`wizard.conf ${key} set`);
    }
  }

  if (!fs.existsSync(ctx.envFile)) errors.push(`missing ${ctx.envFile}`);
  else {
    if (fs.statSync(ctx.envFile).mode & 0o077) {
      errors.push(`${ctx.envFile} must not be world/group readable (want mode 600)`);
    }
    checks.push("hindsight.env present");
  }

  if (!fs.existsSync(ctx.litellmEnv)) errors.push(`missing ${ctx.litellmEnv}`);
  else {
    if (fs.statSync(ctx.litellmEnv).mode & 0o077) {
      errors.push(`${ctx.litellmEnv} must not be world/group readable (want mode 600)`);
    }
    if (!h.envValue(ctx.litellmEnv, "LITELLM_MASTER_KEY")) {
      errors.push("litellm.env missing LITELLM_MASTER_KEY");
    }
    checks.push("litellm.env present");
  }

  const stackEnv = path.join(ctx.repoRoot, ".env");
  if (fs.existsSync(stackEnv)) {
    for (const key of ["LITELLM_CONFIG", "HINDSIGHT_PORT"]) {
      if (!h.envValue(stackEnv, key)) errors.push(`repo .env missing ${key}`);
    }
    checks.push("repo .env ports and litellm config");
  }

  const llmBase = h.envValue(ctx.envFile, "HINDSIGHT_API_LLM_BASE_URL");
  const llmKey = h.envValue(ctx.envFile, "HINDSIGHT_API_LLM_API_KEY");
  const master = h.envValue(ctx.litellmEnv, "LITELLM_MASTER_KEY");
  if (llmBase !== "http://litellm:4000/v1") {
    errors.push("hindsight.env not wired to LiteLLM proxy (HINDSIGHT_API_LLM_BASE_URL)");
  }
  if (!llmKey || !master || llmKey !== master) {
    errors.push("hindsight.env LLM API key must match LITELLM_MASTER_KEY");
  }
  checks.push("LiteLLM proxy wiring");

  const backend = conf("MEMORY_BACKEND");
  const model = conf("MEMORY_MODEL");
  const shipped = backend === "ollama" ? ctx.ollamaDefaultModel : ctx.lemondDefaultModel;
  const reflect = conf("MEMORY_REFLECT_MODEL");
  if (backend !== "custom" && model !== shipped && !reflect && !fs.existsSync(ctx.litellmOverride)) {
    errors.push("custom model without litellm.yaml override");
  }
}
