/**
 * Hindsight's contribution to scripts/setup.mjs: the LiteLLM proxy secrets file, the
 * LITELLM_CONFIG and port entries of the stack .env, and the hindsight.env migration.
 * Runs as a plain Node script step (no wizard context), so it only reads process
 * environment and the paths it is given.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { envValue } from "../../../wizard/lib/paths.mjs";

/**
 * @param {{ repo: string, home: string, env: NodeJS.ProcessEnv }} opts
 * @returns {{ entries: [string, string][], drop: string[], report: string[] }}
 *   entries: KEY=value lines to add to the stack .env; drop: keys to remove first;
 *   report: KEY=value strings echoed in the "wrote .env" line
 */
export function prepareStackEnv({ repo, home, env }) {
  const litellmEnv =
    env.LITELLM_ENV_FILE || path.join(home, ".config/hindsight/litellm.env");
  const overrideConfig = path.join(home, ".config/hindsight/litellm.yaml");
  const backend = env.MEMORY_BACKEND || "lemond";

  if (!["lemond", "ollama"].includes(backend)) {
    throw new Error(`MEMORY_BACKEND must be lemond or ollama (got: ${backend})`);
  }

  if (!fs.existsSync(litellmEnv)) {
    const key = crypto.randomBytes(24).toString("hex");
    const body =
      "# LiteLLM proxy secrets. Read by the litellm compose service. Do not commit.\n" +
      `LITELLM_MASTER_KEY=sk-${key}\n` +
      "# lemond ignores the key; any non-empty value works.\n" +
      "LEMOND_API_KEY=placeholder\n" +
      "# Hosted models: add the provider key here, e.g. ANTHROPIC_API_KEY=..., and reference it as os.environ/ANTHROPIC_API_KEY.\n";
    fs.writeFileSync(litellmEnv, body, { mode: 0o600 });
    console.log(`created ${litellmEnv} (mode 600)`);
  }

  const litellmConfig = fs.existsSync(overrideConfig)
    ? overrideConfig
    : path.join(repo, "config", `litellm.${backend}.yaml`);

  /** @type {[string, string][]} */
  const entries = [
    ["LITELLM_CONFIG", litellmConfig],
    ["COMPOSE_PROFILES", "hindsight"],
  ];
  const drop = ["LITELLM_CONFIG", "COMPOSE_PROFILES"];
  if (env.HINDSIGHT_PORT) {
    drop.push("HINDSIGHT_PORT");
    entries.push(["HINDSIGHT_PORT", env.HINDSIGHT_PORT]);
  }
  if (env.HINDSIGHT_CP_PORT) {
    drop.push("HINDSIGHT_CP_PORT");
    entries.push(["HINDSIGHT_CP_PORT", env.HINDSIGHT_CP_PORT]);
  }
  return { entries, drop, report: [`LITELLM_CONFIG=${litellmConfig}`] };
}

/**
 * Point hindsight.env at the LiteLLM proxy (backs the file up first; prints no values).
 * @param {{ repo: string, home: string, env: NodeJS.ProcessEnv }} opts
 */
export function migrateEnv({ home, env }) {
  const hindsightEnv =
    env.HINDSIGHT_ENV_FILE || path.join(home, ".config/hindsight/hindsight.env");
  const litellmEnv =
    env.LITELLM_ENV_FILE || path.join(home, ".config/hindsight/litellm.env");
  if (!fs.existsSync(hindsightEnv)) {
    throw new Error(`no ${hindsightEnv} to migrate`);
  }
  const key = envValue(litellmEnv, "LITELLM_MASTER_KEY");
  if (!key) {
    throw new Error(`LITELLM_MASTER_KEY missing from ${litellmEnv}`);
  }
  const backup = `${hindsightEnv}.bak-${Date.now()}`;
  fs.copyFileSync(hindsightEnv, backup);
  const llmLines = [
    "HINDSIGHT_API_LLM_PROVIDER=openai",
    "HINDSIGHT_API_LLM_BASE_URL=http://litellm:4000/v1",
    "HINDSIGHT_API_LLM_MODEL=memory-reflect",
    `HINDSIGHT_API_LLM_API_KEY=${key}`,
    "HINDSIGHT_API_RETAIN_LLM_MODEL=memory-retain",
    "HINDSIGHT_API_REFLECT_LLM_MODEL=memory-reflect",
    "HINDSIGHT_API_CONSOLIDATION_LLM_MODEL=memory-consolidate",
    "HINDSIGHT_API_MENTAL_MODEL_REFRESH_LLM_MODEL=memory-reflect",
  ];
  const keys = llmLines.map((l) => l.split("=")[0]);
  const keyRe = new RegExp(`^(${keys.join("|")})=`);
  const rest = fs
    .readFileSync(hindsightEnv, "utf8")
    .split("\n")
    .filter((l) => l && !keyRe.test(l));
  fs.writeFileSync(hindsightEnv, `${[...rest, ...llmLines].join("\n")}\n`, { mode: 0o600 });
  console.log(
    `migrated ${hindsightEnv} to the LiteLLM proxy (backup: ${backup}). Values not printed.`,
  );
  console.log("Next: docker compose up -d   (recreates hindsight with the new env)");
}

/**
 * Printed after the .env is written when hindsight.env still calls a model server directly.
 * @param {{ home: string, env: NodeJS.ProcessEnv }} opts
 * @returns {string[]}
 */
export function setupNotices({ home, env }) {
  const hindsightEnv =
    env.HINDSIGHT_ENV_FILE || path.join(home, ".config/hindsight/hindsight.env");
  if (
    fs.existsSync(hindsightEnv) &&
    /^HINDSIGHT_API_LLM_BASE_URL=http:\/\/host\.docker\.internal:/m.test(
      fs.readFileSync(hindsightEnv, "utf8"),
    )
  ) {
    return [
      `NOTE: ${hindsightEnv} still calls the model server directly.`,
      "      Run: node scripts/setup.mjs --migrate-env   (backs up the file, rewrites only LLM lines)",
    ];
  }
  return [];
}
