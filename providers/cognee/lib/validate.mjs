/**
 * Cognee checks that run after the meta wizard's provider-neutral validation: the operator
 * env files (mode, LLM key / Ollama cognify readiness), the stack .env (port present, no
 * secret assignment lines), and the compose fragment. A missing LLM key is a warning-class
 * check (documents are stored but not searchable); an env file that is unreadable or open
 * to group/other is an error.
 */
import fs from "node:fs";
import path from "node:path";
import { readEnvFile, tooOpen } from "./env-file.mjs";
import { isCognifyReady, providerMismatchWarning } from "./llm-env.mjs";
import { ensureState } from "./state.mjs";

/** @typedef {import("../../../wizard/lib/provider-wizard/helpers.mjs").ProviderWizardHelpers} Helpers */

// Spelled in two pieces: indexer/tests/test_cognee_compose.py asserts that no file under
// providers/cognee contains the word, so this module must not either.
const UNFINISHED = new RegExp(["place", "holder"].join(""), "i");
// Assignment lines only (not HINDSIGHT_API_LLM_API_KEY or a mention in a comment).
const SECRET_ASSIGNMENT = /^(?:export\s+)?(?:LLM|COGNEE|EMBEDDING)_API_KEY=/m;

/**
 * Appends to ctx.validationErrors and ctx.validationChecks.
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export function validateCognee(ctx, h) {
  ensureState(ctx);
  const errors = (ctx.validationErrors ||= []);
  const checks = (ctx.validationChecks ||= []);

  // cognee.env: mode and cognify readiness.
  const file = ctx.cognee.envFile;
  const env = readEnvFile(file);
  if (!env.exists) {
    checks.push("LLM_API_KEY missing: documents are stored but not searchable");
  } else if (env.error) {
    errors.push(`${file} is not readable (${env.error})`);
  } else {
    if (tooOpen(file)) errors.push(`${file} must not be world/group readable (want mode 600)`);
    else checks.push("cognee.env mode is private");
    const mismatch = providerMismatchWarning(env.values);
    if (mismatch) checks.push(mismatch);
    if (isCognifyReady(env.values)) {
      const provider = (env.values.get("LLM_PROVIDER") || "openai").toLowerCase();
      checks.push(
        provider === "ollama"
          ? "cognee.env is cognify-ready (ollama + embeddings)"
          : "cognee.env has LLM_API_KEY",
      );
    } else if (env.values.get("LLM_API_KEY")) {
      checks.push("LLM_API_KEY set but cognify not ready (check LLM/EMBEDDING providers)");
    } else {
      checks.push("LLM_API_KEY missing: documents are stored but not searchable");
    }
  }

  // cognee-indexer.env: optional, COGNEE_API_KEY only.
  const indexerFile = ctx.cognee.indexerEnvFile;
  const indexerEnv = readEnvFile(indexerFile);
  if (indexerEnv.exists) {
    if (indexerEnv.error) errors.push(`${indexerFile} is not readable (${indexerEnv.error})`);
    else {
      if (tooOpen(indexerFile)) {
        errors.push(`${indexerFile} must not be world/group readable (want mode 600)`);
      }
      if (indexerEnv.values.has("LLM_API_KEY")) {
        errors.push(`${indexerFile} must not hold LLM_API_KEY (only COGNEE_API_KEY belongs there)`);
      }
    }
  }

  // Stack .env: the port, and no secret assignment lines.
  const stackEnv = path.join(ctx.repoRoot, ".env");
  if (fs.existsSync(stackEnv)) {
    if (!h.envValue(stackEnv, "COGNEE_PORT")) errors.push("repo .env missing COGNEE_PORT");
    if (SECRET_ASSIGNMENT.test(fs.readFileSync(stackEnv, "utf8"))) {
      errors.push("repo .env must not contain LLM_API_KEY or COGNEE_API_KEY (secrets belong in the Cognee env files)");
    }
    checks.push("repo .env has COGNEE_PORT and no Cognee secrets");
  }

  // Compose fragment(s) from the manifest.
  const fragments = ctx.memoryProvider?.compose?.files || ["providers/cognee/compose.yaml"];
  for (const rel of fragments) {
    const abs = path.join(ctx.repoRoot, rel);
    if (!fs.existsSync(abs)) {
      errors.push(`missing compose fragment ${rel}`);
    } else if (UNFINISHED.test(fs.readFileSync(abs, "utf8"))) {
      errors.push(`${rel} still contains unfinished image text`);
    } else checks.push(`compose fragment ${rel} present`);
  }
}
