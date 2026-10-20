/**
 * Smoke test for a mem0 REST server (replaces the manifest HTTP smoke, which has no header
 * support): GET /docs, POST /memories (verbatim, infer false), POST /search must find the
 * fact, then delete what was created. Cleanup runs on every outcome.
 */
import path from "node:path";
import { readKey } from "./env-file.mjs";
import { describeError, redact, request } from "./http.mjs";
import { ensureState, resolveEnvFile } from "./state.mjs";
import { displayUrl, resolveApiUrl, urlProblem } from "./url.mjs";

/** @typedef {import("../../../wizard/lib/provider-wizard/helpers.mjs").ProviderWizardHelpers} Helpers */

export const SMOKE_USER = "wizard-smoke";
export const SMOKE_RUN = "wizard-smoke-doc";
export const SMOKE_FACT = "Wizard smoke test: the project codename is heron.";

const RETAIN_BODY = {
  messages: [{ role: "user", content: SMOKE_FACT }],
  user_id: SMOKE_USER,
  agent_id: "personal-memory-wizard",
  run_id: SMOKE_RUN,
  infer: false,
};
const SEARCH_BODY = {
  query: "What is the project codename?",
  filters: { user_id: SMOKE_USER },
};

class SmokeFailure extends Error {}

/** @param {any} json @returns {string[]} */
function memoryIds(json) {
  const list = Array.isArray(json) ? json : Array.isArray(json?.results) ? json.results : json?.id ? [json] : [];
  return list.map((r) => r?.id).filter((id) => typeof id === "string" && id);
}

/** @param {any} json @returns {string} */
function memoryText(json) {
  const list = Array.isArray(json) ? json : Array.isArray(json?.results) ? json.results : [];
  return list.map((r) => String(r?.memory ?? r?.text ?? "")).join("\n");
}

/**
 * The key the indexer would send: the env file first (the indexer reads only that), then
 * the environment.
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
function smokeKey(ctx, h) {
  const fromFile = readKey(resolveEnvFile(ctx, h));
  if (fromFile) return { key: fromFile, fromFile: true };
  return { key: (process.env.MEM0_API_KEY || "").trim(), fromFile: false };
}

/**
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export async function smoke(ctx, h) {
  ensureState(ctx);
  const raw = resolveApiUrl(ctx, h);
  const issue = urlProblem(raw);
  if (issue) {
    h.problem(ctx, `mem0 API URL: ${issue}`);
    return;
  }
  const base = displayUrl(raw);

  if (ctx.dry) {
    h.info(`[dry-run] mem0 smoke test against ${base}:`);
    h.info("[dry-run]   1. GET /docs must answer 2xx");
    h.info(`[dry-run]   2. POST /memories one fact (infer false, user_id ${SMOKE_USER}, run_id ${SMOKE_RUN})`);
    h.info("[dry-run]   3. POST /search the codename; the result must contain 'heron'");
    h.info("[dry-run]   4. DELETE /memories/{id} for every memory created in step 2");
    return;
  }

  const { key, fromFile } = smokeKey(ctx, h);
  if (key && !fromFile) {
    h.warn(
      `the API key comes from the environment only; the indexer reads ${path.basename(resolveEnvFile(ctx, h))} ` +
        "(put MEM0_API_KEY there)",
    );
  }
  /** @param {{ status: number, text: string }} res @param {string} what */
  const failed = (res, what) => {
    if (res.status === 401 || res.status === 403) {
      return new SmokeFailure(
        `${what}: the mem0 server answered ${res.status}. Put MEM0_API_KEY in ${resolveEnvFile(ctx, h)} ` +
          "(mode 600) or run the server with AUTH_DISABLED, then rerun",
      );
    }
    const body = redact(res.text, key).slice(0, 200).replace(/\s+/g, " ");
    return new SmokeFailure(`${what}: the mem0 server answered ${res.status}${body ? ` (${body})` : ""}`);
  };

  h.info(`smoke test: mem0 at ${base}`);
  /** @type {string[]} */
  let ids = [];
  /** @type {string} */
  let failure = "";
  try {
    // 1. Reachability (open route, no key).
    const docs = await request(base, "GET", "/docs", { timeoutMs: 10000 });
    if (!docs.ok) throw failed(docs, "GET /docs");
    h.ok("GET /docs answered");

    // 2. Retain verbatim.
    const retain = await request(base, "POST", "/memories", { key, body: RETAIN_BODY, timeoutMs: 120000 });
    if (!retain.ok) throw failed(retain, "POST /memories");
    ids = memoryIds(retain.json);
    h.ok(`stored the smoke fact (${ids.length} memory)`);

    // 3. Search must find it.
    const search = await request(base, "POST", "/search", { key, body: SEARCH_BODY, timeoutMs: 120000 });
    if (!search.ok) throw failed(search, "POST /search");
    if (!/heron/i.test(memoryText(search.json))) {
      throw new SmokeFailure(
        "POST /search did not return the smoke fact: check the mem0 server's embedder key and provider " +
          "configuration, and its logs",
      );
    }
    h.ok("POST /search found the smoke fact");
  } catch (e) {
    failure = e instanceof SmokeFailure ? e.message : `mem0 request failed (${redact(describeError(e), key)})`;
  }

  // 4. Cleanup, whatever happened above.
  try {
    if (!ids.length) {
      // The retain answer had no usable ids (or failed midway): look the smoke memories up.
      const listed = await request(
        base,
        "GET",
        `/memories?user_id=${SMOKE_USER}&run_id=${SMOKE_RUN}&top_k=1000`,
        { key, timeoutMs: 30000 },
      ).catch(() => null);
      if (listed?.ok) ids = memoryIds(listed.json);
    }
    let removed = 0;
    for (const id of ids) {
      try {
        const res = await request(base, "DELETE", `/memories/${encodeURIComponent(id)}`, { key, timeoutMs: 30000 });
        if (res.ok || res.status === 404) removed++;
        else h.warn(`could not delete smoke memory ${id}: the server answered ${res.status}`);
      } catch (e) {
        h.warn(`could not delete smoke memory ${id}: ${redact(describeError(e), key)}`);
      }
    }
    if (ids.length && removed === ids.length) h.ok("deleted the smoke memories");
  } catch (e) {
    h.warn(`smoke cleanup failed: ${redact(describeError(e), key)}`);
  }

  if (failure) h.die(failure);
}
