import { callUnifiedTool } from "../mcp/memory-facade.mjs";

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
