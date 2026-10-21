import path from "node:path";
import { envValue } from "../../wizard/lib/paths.mjs";

/** OpenAI-compatible chat URL for cross-provider reflect synthesis (optional). */
export function resolveLlmChatUrl({ home, stackRoot, env = process.env }) {
  const direct = String(env.PM_LLM_URL || env.OPENAI_API_BASE || "").trim();
  if (direct) return direct.replace(/\/+$/, "").replace(/\/v1$/, "") + (direct.includes("/v1") ? "" : "/v1");
  const fromEnv = envValue(path.join(stackRoot, ".env"), "LITELLM_URL");
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  const port = envValue(path.join(stackRoot, ".env"), "LITELLM_PORT") || "4000";
  return `http://127.0.0.1:${String(port).trim()}/v1`;
}

export function resolveLlmModel(env = process.env) {
  return String(env.PM_LLM_MODEL || env.PM_REFLECT_MODEL || "memory-reflect").trim() || "memory-reflect";
}

export function resolveLlmApiKey(env = process.env) {
  return String(env.PM_LLM_API_KEY || env.LITELLM_MASTER_KEY || env.OPENAI_API_KEY || "").trim();
}

/**
 * @param {{ query: string, context: string, model?: string, baseUrl: string, apiKey?: string }} opts
 * @param {typeof fetch} fetchFn
 */
export async function synthesizeReflectAnswer(opts, fetchFn = fetch) {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const url = `${base}/chat/completions`;
  const headers = { "content-type": "application/json" };
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
  const body = {
    model: opts.model || resolveLlmModel(),
    messages: [
      {
        role: "system",
        content:
          "Summarize the following memory search hits as concise session context for a coding agent. " +
          "Do not invent facts not present in the hits.",
      },
      { role: "user", content: `Question: ${opts.query}\n\nMemory hits:\n${opts.context}` },
    ],
    max_tokens: 1024,
    temperature: 0.2,
  };
  const res = await fetchFn(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`LLM synthesize → ${res.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  return json?.choices?.[0]?.message?.content?.trim() || text;
}
