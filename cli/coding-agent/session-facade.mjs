import { callUnifiedTool } from "../mcp/memory-facade.mjs";
import { providerSupports } from "./capabilities.mjs";

function toolText(result) {
  const t = result?.content?.[0]?.text;
  if (!t) return "";
  try {
    const j = JSON.parse(t);
    if (j?.result?.results) return JSON.stringify(j.result.results, null, 2);
    if (j?.result) return typeof j.result === "string" ? j.result : JSON.stringify(j.result, null, 2);
    return typeof j === "string" ? j : JSON.stringify(j, null, 2);
  } catch {
    return String(t);
  }
}

/** @param {ReturnType<import("../mcp/context.mjs").resolveMcpContext>} ctx */
export async function sessionRecall(ctx, { query, bank, limit = 10 }, fetchFn = fetch) {
  const out = await callUnifiedTool(ctx, "memory_recall", { query, bank, limit }, fetchFn);
  if (out.isError) throw new Error(toolText(out));
  return toolText(out);
}

/** @param {ReturnType<import("../mcp/context.mjs").resolveMcpContext>} ctx */
export async function sessionRetain(ctx, { content, bank }, fetchFn = fetch) {
  const text = String(content || "").trim();
  if (!text) return;
  const out = await callUnifiedTool(ctx, "memory_add", { content: text, bank }, fetchFn);
  if (out.isError) throw new Error(toolText(out));
}

/** Reflect when supported; otherwise search-backed preamble (explicit, not LLM reflect). */
export async function sessionReflectOrSearch(ctx, { query, bank, limit = 12 }, fetchFn = fetch) {
  if (providerSupports(ctx.provider, "reflect")) {
    return sessionRecall(ctx, { query, bank, limit }, fetchFn);
  }
  const out = await callUnifiedTool(ctx, "memory_search", { query, bank, limit }, fetchFn);
  if (out.isError) throw new Error(toolText(out));
  const body = toolText(out);
  return body ? `[Memory search — ${ctx.provider} has no LLM reflect; showing search hits]\n${body}` : "";
}
