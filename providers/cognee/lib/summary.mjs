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
  const configFiles = [`  ${ctx.cognee.envFile} (cognify settings, mode 600)`];
  if (fs.existsSync(ctx.cognee.indexerEnvFile)) {
    configFiles.push(`  ${ctx.cognee.indexerEnvFile} (indexer API key, mode 600)`);
  }
  configFiles.push(`  ${path.join(ctx.repoRoot, ".env")} (COGNEE_PORT, COMPOSE_PROFILES)`);
  const env = readEnvFile(ctx.cognee.envFile);
  const ready = isCognifyReady(env.values);
  const provider = (env.values.get("LLM_PROVIDER") || "").toLowerCase();
  const emb = (env.values.get("EMBEDDING_PROVIDER") || "").toLowerCase();
  const extractor = (env.values.get("GRAPH_EXTRACTOR") || "").toLowerCase();
  let readyNote;
  if (!ready) {
    readyNote =
      `Cognee needs a cognify-ready config in ${ctx.cognee.envFile}: ` +
      "GRAPH_EXTRACTOR=gliner_demo + FastEmbed (default), LLM_PROVIDER=ollama, or LLM_API_KEY; " +
      "without it documents are stored but not searchable. Then restart with: ./pm up";
  } else if (extractor === "gliner_demo" || emb === "fastembed") {
    readyNote =
      `Cognee builds its graph with local GLiNER + FastEmbed from ${ctx.cognee.envFile}; ` +
      "change it there, then restart with: ./pm up";
  } else if (provider === "ollama") {
    readyNote =
      `Cognee builds its graph with Ollama from ${ctx.cognee.envFile}; change it there, then restart with: ./pm up`;
  } else {
    readyNote =
      `Cognee builds its graph with the LLM configured in ${ctx.cognee.envFile}; change it there, then restart with: ./pm up`;
  }
  const notes = [
    readyNote,
    `Graph status: GET ${url}/api/v1/datasets/status`,
    "The first start downloads a large image and may take several minutes; GLiNER/FastEmbed add ~800 MB on first cognify.",
    "Deleting a dataset removes its graph and vectors, not just the stored files.",
    `Coding agents: no plugin — call the REST API at ${url} (see /docs); ingest POST /api/v1/add, then cognify, then search.`,
  ];
  return { running, configFiles, notes, logServices: ["cognee", "indexer"] };
}
