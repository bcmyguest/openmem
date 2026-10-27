import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveStackRoot } from "../stack.mjs";
import { cogneeDatasetName } from "./export/cognee-dataset-name.mjs";
import { resolveLlmApiKey, resolveLlmChatUrl, resolveLlmModel, synthesizeReflectAnswer } from "./llm-synthesize.mjs";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const DEFAULT_BANK = "personal-memory-mcp";

function hitsFromMem0(json) {
  const rows = json?.results || json?.memories || [];
  return rows.map((r) => r.memory ?? r.text ?? r.content ?? JSON.stringify(r)).join("\n---\n");
}

function hitsFromCognee(json) {
  if (typeof json === "string") return json;
  const rows = json?.search_result || json?.results || json?.data || json;
  return typeof rows === "string" ? rows : JSON.stringify(rows, null, 2);
}

/**
 * @param {ReturnType<import("./context.mjs").resolveMcpContext>} ctx
 * @param {Record<string, unknown>} args
 * @param {(name: string, args: Record<string, unknown>, fetchFn: typeof fetch) => Promise<{ content: { text: string }[], isError?: boolean }>} callTool
 * @param {typeof fetch} fetchFn
 */
export async function callMemoryReflect(ctx, args, callTool, fetchFn = fetch) {
  const query = String(args.query || "").trim();
  if (!query) throw new Error("query is required");
  const bank = String(args.bank || DEFAULT_BANK).trim() || DEFAULT_BANK;
  const limit = Number(args.limit) > 0 ? Number(args.limit) : 12;

  if (ctx.provider === "hindsight" && ctx.hindsightUrl) {
    const base = ctx.hindsightUrl.replace(/\/+$/, "");
    const enc = encodeURIComponent(bank);
    const res = await fetchFn(`${base}/v1/default/banks/${enc}/reflect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, budget: "low", max_tokens: 1024 }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Hindsight reflect → ${res.status}: ${text.slice(0, 300)}`);
    const result = JSON.parse(text);
    return { provider: "hindsight", bank, query, mode: "hindsight_reflect", answer: result.text, result };
  }

  const searchOut = await callTool("memory_search", { query, bank, limit }, fetchFn);
  const raw = searchOut.content?.[0]?.text || "";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { text: raw };
  }
  const hits =
    ctx.provider === "mem0"
      ? hitsFromMem0(parsed?.result ?? parsed)
      : ctx.provider === "cognee"
        ? hitsFromCognee(parsed?.result ?? parsed)
        : raw;

  const home = process.env.HOME || "";
  const stackRoot = resolveStackRoot({ pkgRoot: PKG_ROOT, home, env: process.env }).root;
  const llmUrl = resolveLlmChatUrl({ home, stackRoot, env: process.env });
  const apiKey = resolveLlmApiKey(process.env);
  try {
    const synthesized = await synthesizeReflectAnswer(
      { query, context: hits || "(no hits)", baseUrl: llmUrl, apiKey, model: resolveLlmModel() },
      fetchFn,
    );
    return {
      provider: ctx.provider,
      bank,
      query,
      mode: "search_synthesize",
      llm: llmUrl,
      answer: synthesized,
    };
  } catch (err) {
    return {
      provider: ctx.provider,
      bank,
      query,
      mode: "search_only",
      note: `LLM synthesis unavailable (${err instanceof Error ? err.message : err}); returning raw hits`,
      hits,
    };
  }
}

/**
 * @param {ReturnType<import("./context.mjs").resolveMcpContext>} ctx
 * @param {Record<string, unknown>} args
 * @param {typeof fetch} fetchFn
 */
export async function callMemoryConsolidate(ctx, args, fetchFn = fetch) {
  const bank = String(args.bank || DEFAULT_BANK).trim() || DEFAULT_BANK;
  if (ctx.provider === "cognee" && ctx.cognee?.baseUrl) {
    const base = ctx.cognee.baseUrl.replace(/\/+$/, "");
    const dataset = cogneeDatasetName(bank);
    const headers = { "content-type": "application/json", ...(ctx.cognee.apiKey ? { "X-Api-Key": ctx.cognee.apiKey } : {}) };
    const res = await fetchFn(`${base}/api/v1/cognify`, {
      method: "POST",
      headers,
      body: JSON.stringify({ datasets: [dataset], runInBackground: true }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Cognee cognify → ${res.status}: ${text.slice(0, 300)}`);
    return { provider: "cognee", bank, dataset, result: JSON.parse(text) };
  }
  if (ctx.provider === "hindsight" && ctx.hindsightUrl) {
    return {
      provider: "hindsight",
      bank,
      note: "Hindsight consolidation runs via the Hindsight API/LiteLLM memory-consolidate route during retain cycles; no separate MCP trigger yet.",
    };
  }
  return { provider: ctx.provider, bank, skipped: true, reason: "No consolidate equivalent for this provider" };
}
