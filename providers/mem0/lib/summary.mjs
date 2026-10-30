/** mem0's contribution to the wizard's closing summary. */
import path from "node:path";
import { readKey } from "./env-file.mjs";
import { LLM_ALIAS, litellmEnvFile, routesFile } from "./litellm.mjs";
import { MERIDIAN_TERMS_URL } from "../../hindsight/lib/meridian.mjs";
import { resolveEnvFile, ensureState } from "./state.mjs";
import { containerUrl, displayUrl, resolveApiUrl, urlProblem } from "./url.mjs";

/** @typedef {import("../../../wizard/lib/provider-wizard/helpers.mjs").ProviderWizardHelpers} Helpers */

const DOCS = "https://docs.mem0.ai/open-source/features/rest-api";
const OPERATOR = "providers/mem0/OPERATOR.md";

/**
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 * @returns {{ running: string[], configFiles: string[], notes: string[], logServices: string[] }}
 */
export function summary(ctx, h) {
  ensureState(ctx);
  const raw = resolveApiUrl(ctx, h);
  const valid = !urlProblem(raw);
  const url = valid ? displayUrl(raw) : "(invalid URL)";
  const envFile = resolveEnvFile(ctx, h);

  const running = [
    `  mem0 API           ${url}  external server (not managed by this stack)`,
    `  indexer sink       mem0 -> ${valid ? containerUrl(raw) : "(invalid URL)"} (the container's view)`,
  ];
  const configFiles = [
    `  ${envFile} (MEM0_API_KEY for the indexer, mode 600)`,
    `  ${path.join(ctx.repoRoot, ".env")} (MEM0_API_URL, MEM0_INDEXER_URL; no secrets)`,
  ];

  // The stack LiteLLM option: this run's answer, else what the last configure run saved (`--up`, `--down`).
  const saved = (k) => (ctx.wizardConf ? h.envValue(ctx.wizardConf, k) : "");
  const litellm =
    ctx.mem0?.litellm !== undefined
      ? ctx.mem0.litellm
      : saved("MEM0_LITELLM") === "1"
        ? { backend: saved("MEM0_LITELLM_BACKEND"), model: saved("MEM0_LITELLM_MODEL"), port: saved("MEM0_LITELLM_PORT") || "4000" }
        : null;
  /** @type {string[]} */
  const logServices = ["indexer"];
  if (litellm) {
    running.push(
      `  LiteLLM (mem0)     http://127.0.0.1:${litellm.port}/v1  ${LLM_ALIAS} -> ${litellm.backend} ${litellm.model}; loopback only, master key required`,
    );
    configFiles.push(`  ${routesFile(ctx.home)} (mem0 LiteLLM routes)`, `  ${litellmEnvFile(ctx.home)} (LITELLM_MASTER_KEY and provider keys, mode 600)`);
    logServices.push("litellm");
  }

  /** @type {string[]} */
  const notes = [];
  if (ctx.action === "down") return { running, configFiles, notes, logServices };
  let loopback = false;
  if (valid) {
    const parsed = new URL(raw);
    loopback = ["127.0.0.1", "localhost", "0.0.0.0", "[::1]"].includes(parsed.hostname);
  }
  let hasKey = false;
  try {
    hasKey = readKey(envFile) !== "";
  } catch {
    hasKey = false;
  }
  if (!hasKey) {
    notes.push(
      `API key: create one in your mem0 dashboard (port varies by install) or with POST /api-keys, then put MEM0_API_KEY=<key> in ${envFile} (mode 600). ` +
        "A server run with AUTH_DISABLED=true needs none (development only).",
    );
  }
  notes.push(
    `The mem0 server is yours to run: first-time setup (JWT_SECRET, embedder keys) is provider-native — ${OPERATOR} and ${DOCS}`,
    loopback
      ? "The indexer container reaches a loopback server as host.docker.internal; on Linux a server bound only to 127.0.0.1 is not reachable that way: bind it to 0.0.0.0 or the docker bridge IP, or use a hostname in MEM0_API_URL."
      : "The indexer container must be able to reach the server at the URL above (it uses the same host name).",
  );
  if (litellm) {
    notes.push(
      `mem0's LLM: point your mem0 config at http://127.0.0.1:${litellm.port}/v1 (provider openai, model ${LLM_ALIAS}, api_key = LITELLM_MASTER_KEY); ./setup printed the blocks. See docs/mem0.md.`,
    );
    if (litellm.backend === "meridian") {
      notes.push(`Claude subscription use through Meridian is governed by Anthropic's Consumer Terms: ${MERIDIAN_TERMS_URL}`);
    }
  }
  return { running, configFiles, notes, logServices };
}
