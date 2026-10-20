/** Cognee's contribution to the wizard's closing summary. */
import fs from "node:fs";
import path from "node:path";
import { readEnvFile } from "./env-file.mjs";
import { isCognifyReady } from "./llm-env.mjs";
import { currentPort, ensureState } from "./state.mjs";

/**
 * Lines the meta wizard prints in its summary, in the order it prints them.
 * @param {Record<string, any>} ctx
 * @returns {{ running: string[], configFiles: string[], notes: string[], logServices: string[] }}
 */
export function summary(ctx) {
  ensureState(ctx);
  const url = ctx.cogneeUrl || `http://127.0.0.1:${currentPort(ctx)}`;
  const running = [
    `  Cognee API         ${url}  (docs: ${url}/docs)`,
    "  indexer sink       cognee -> http://cognee:8000 (internal network)",
    "  ingestion is asynchronous: the indexer requests cognify once per changed dataset",
  ];
  const configFiles = [`  ${ctx.cognee.envFile} (LLM settings, mode 600)`];
  if (fs.existsSync(ctx.cognee.indexerEnvFile)) {
    configFiles.push(`  ${ctx.cognee.indexerEnvFile} (indexer API key, mode 600)`);
  }
  configFiles.push(`  ${path.join(ctx.repoRoot, ".env")} (COGNEE_PORT, COMPOSE_PROFILES)`);
  const env = readEnvFile(ctx.cognee.envFile);
  const ready = isCognifyReady(env.values);
  const provider = (env.values.get("LLM_PROVIDER") || "").toLowerCase();
  const notes = [
    ready
      ? provider === "ollama"
        ? `Cognee builds its graph with Ollama (LLM + embeddings) from ${ctx.cognee.envFile}; change it there, then restart with: ./pm up`
        : `Cognee builds its graph with the LLM configured in ${ctx.cognee.envFile}; change it there, then restart with: ./pm up`
      : `Cognee needs a cognify-ready LLM config: set LLM_API_KEY in ${ctx.cognee.envFile}, or use LLM_PROVIDER=ollama with matching embeddings; without it documents are stored but not searchable. Then restart with: ./pm up`,
    `Graph status: GET ${url}/api/v1/datasets/status`,
    "The first start downloads a large image and may take several minutes.",
    "Deleting a dataset removes its graph and vectors, not just the stored files.",
    `Coding agents: no plugin — call the REST API at ${url} (see /docs); ingest POST /api/v1/add, then cognify, then search.`,
  ];
  return { running, configFiles, notes, logServices: ["cognee", "indexer"] };
}
