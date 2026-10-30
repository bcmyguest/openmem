import { callUnifiedTool } from "../mcp/memory-facade.mjs";
import { recallBlock } from "./recall-frame.mjs";

export const HOOK_CONTEXT_MAX_CHARS = 8000;

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

function recallText(result, limit, maxChars = HOOK_CONTEXT_MAX_CHARS) {
  try {
    const value = JSON.parse(result?.content?.[0]?.text || "");
    const hits = value?.result?.results;
    if (Array.isArray(hits)) {
      return hits.slice(0, limit)
        .map((hit) => hit?.text ?? hit?.memory ?? hit?.content ?? "")
        .filter((item) => typeof item === "string" && item.trim())
        .join("\n\n")
        .slice(0, maxChars);
    }
  } catch { /* use generic result text */ }
  return toolText(result).slice(0, maxChars);
}

/**
 * Hook or plugin recall text framed as untrusted data (recall-frame.mjs), at most HOOK_CONTEXT_MAX_CHARS
 * characters frame included; "" for empty text.
 */
export function hookRecallBlock(text) {
  return recallBlock(String(text ?? "").trim(), HOOK_CONTEXT_MAX_CHARS);
}

/** @param {ReturnType<import("../mcp/context.mjs").resolveMcpContext>} ctx */
export async function sessionRecall(ctx, { query, bank, limit = 10, budget, maxTokens, maxChars }, fetchFn = fetch) {
  const out = await callUnifiedTool(ctx, "memory_recall", { query, bank, limit, budget, maxTokens }, fetchFn);
  if (out.isError) throw new Error(toolText(out));
  return recallText(out, limit, maxChars);
}

/** @param {ReturnType<import("../mcp/context.mjs").resolveMcpContext>} ctx */
export async function sessionRetain(ctx, { content, bank }, fetchFn = fetch) {
  const text = String(content || "").trim();
  if (!text) return;
  const out = await callUnifiedTool(ctx, "memory_add", { content: text, bank, async: true }, fetchFn);
  if (out.isError) throw new Error(toolText(out));
}

/** SessionStart context via unified memory_reflect (all providers). */
export async function sessionReflectOrSearch(ctx, { query, bank, limit = 12 }, fetchFn = fetch) {
  const out = await callUnifiedTool(ctx, "memory_reflect", { query, bank, limit }, fetchFn);
  if (out.isError) throw new Error(toolText(out));
  const body = toolText(out);
  try {
    const j = JSON.parse(body);
    if (j.answer) return String(j.answer);
    if (j.result) return typeof j.result === "string" ? j.result : JSON.stringify(j.result, null, 2);
    if (j.hits) return String(j.hits);
  } catch {
    /* plain text */
  }
  return body;
}

/**
 * True when the bank has pending or processing ingest (`memory_status` active > 0).
 * Synchronous providers (mem0) and providers without ingest status (Cognee) report false.
 */
export async function sessionIngestActive(ctx, { bank }, fetchFn = fetch) {
  const out = await callUnifiedTool(ctx, "memory_status", { bank }, fetchFn);
  if (out.isError) throw new Error(toolText(out));
  try {
    const status = JSON.parse(out?.content?.[0]?.text || "");
    return status?.supported !== false && Number(status?.active) > 0;
  } catch {
    return false;
  }
}
