/**
 * Cognee smoke test (replaces the manifest's JSON-only HTTP smoke).
 *
 * Cognee ingests asynchronously (add, then cognify), so the test cannot read back what it
 * wrote through search. It proves the server is up, accepts a multipart document and lists
 * it, then removes its dataset:
 *   1. GET  /health                          (wait, the stack may still be starting)
 *   2. POST /api/v1/datasets                 create dataset `wizard_smoke`
 *   3. POST /api/v1/add (multipart)          upload one small markdown file
 *   4. GET  /api/v1/datasets/{id}/data       the document must be listed
 *   5. DELETE /api/v1/datasets/{id}          always, even after a failure
 * It does not call cognify: the LLM may not be configured yet. X-Api-Key is sent only when
 * COGNEE_API_KEY is set in the environment or in the indexer env file; its value is never
 * printed.
 */
import { readEnvFile } from "./env-file.mjs";
import { SMOKE_DATASET, ensureState } from "./state.mjs";

/** @typedef {import("../../../wizard/lib/provider-wizard/helpers.mjs").ProviderWizardHelpers} Helpers */

export const SMOKE_DOC_ID = "wizard-smoke";
export const SMOKE_FILE = "wizard-smoke.md";
export const SMOKE_TEXT = "Wizard smoke test: the project codename is heron.";

export const RECALL_SKIPPED =
  "recall skipped: Cognee ingests asynchronously (add, then cognify); search results appear once the graph is built";

const DEFAULTS = {
  healthTimeoutMs: 120_000,
  healthIntervalMs: 3_000,
  requestTimeoutMs: 30_000,
  addTimeoutMs: 120_000,
};

/** A step failed; the message is safe to print (no headers, no bodies beyond a short detail). */
class SmokeError extends Error {}

/**
 * The API key for X-Api-Key: the environment first, then the indexer env file.
 * @param {Record<string, any>} ctx
 * @returns {string}
 */
export function apiKeyFor(ctx) {
  const fromEnv = process.env.COGNEE_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  return readEnvFile(ctx.cognee.indexerEnvFile).values.get("COGNEE_API_KEY") || "";
}

/**
 * A short, secret-free reason from an error response: the `detail` string when there is one.
 * @param {Response} res
 */
async function reason(res) {
  let detail = "";
  try {
    const body = JSON.parse(await res.text());
    if (typeof body?.detail === "string") detail = `: ${body.detail.slice(0, 160)}`;
  } catch {
    // not JSON: the status line is enough
  }
  return `HTTP ${res.status}${detail}`;
}

/**
 * @param {Record<string, any>} item one entry of the data listing
 * @returns {string[]} every doc_id the entry carries in its external metadata
 */
function docIds(item) {
  let meta = item?.externalMetadata ?? item?.external_metadata;
  if (typeof meta === "string") {
    try {
      meta = JSON.parse(meta);
    } catch {
      return [];
    }
  }
  const entries = Array.isArray(meta) ? meta : meta ? [meta] : [];
  return entries.map((e) => e?.doc_id).filter((v) => typeof v === "string");
}

/**
 * Run the smoke test.
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 * @param {{ fetch?: typeof fetch, sleep?: (ms: number) => Promise<void>,
 *   healthTimeoutMs?: number, healthIntervalMs?: number,
 *   requestTimeoutMs?: number, addTimeoutMs?: number }} [opts] test seams
 */
export async function runSmoke(ctx, h, opts = {}) {
  ensureState(ctx);
  const o = { ...DEFAULTS, ...opts };
  const doFetch = opts.fetch || globalThis.fetch;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const base = String(await h.apiBase(ctx)).replace(/\/+$/, "");
  const logs = `docker ${h.composeArgs(ctx, "logs", "cognee").join(" ")}`;

  if (ctx.dry) {
    h.info(`[dry-run] smoke test against ${base}:`);
    h.info(`[dry-run]   1. wait for GET ${base}/health (up to 120s)`);
    h.info(`[dry-run]   2. POST ${base}/api/v1/datasets {"name":"${SMOKE_DATASET}"}`);
    h.info(`[dry-run]   3. POST ${base}/api/v1/add (multipart: ${SMOKE_FILE} into ${SMOKE_DATASET})`);
    h.info(`[dry-run]   4. GET ${base}/api/v1/datasets/<id>/data must list the document`);
    h.info(`[dry-run]   5. DELETE ${base}/api/v1/datasets/<id> (always)`);
    h.info(`[dry-run] ${RECALL_SKIPPED}`);
    return;
  }

  const key = apiKeyFor(ctx);
  /** @type {Record<string, string>} */
  const auth = key ? { "X-Api-Key": key } : {};

  /**
   * @param {string} method
   * @param {string} route
   * @param {{ json?: unknown, form?: FormData, timeoutMs?: number }} [req]
   */
  const call = async (method, route, req = {}) => {
    /** @type {Record<string, string>} */
    const headers = { ...auth };
    let body;
    if (req.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(req.json);
    } else if (req.form) body = req.form;
    return doFetch(`${base}${route}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(req.timeoutMs ?? o.requestTimeoutMs),
    });
  };

  /** @type {string} */
  let datasetId = "";
  /** @type {string} */
  let failure = "";
  try {
    // 1. health
    h.info(`smoke test: waiting for ${base}/health`);
    const deadline = Date.now() + o.healthTimeoutMs;
    let healthy = false;
    for (;;) {
      try {
        healthy = (await call("GET", "/health", { timeoutMs: 5_000 })).ok;
      } catch {
        healthy = false;
      }
      if (healthy || Date.now() >= deadline) break;
      await sleep(o.healthIntervalMs);
    }
    if (!healthy) throw new SmokeError(`GET /health did not answer 2xx within ${Math.round(o.healthTimeoutMs / 1000)}s`);

    // 2. dataset
    const created = await call("POST", "/api/v1/datasets", { json: { name: SMOKE_DATASET } });
    if (!created.ok) throw new SmokeError(`create dataset failed (${await reason(created)})`);
    const dataset = await created.json().catch(() => null);
    datasetId = typeof dataset?.id === "string" ? dataset.id : "";
    if (!datasetId) throw new SmokeError("create dataset returned no id");

    // 3. add (multipart)
    const form = new FormData();
    form.append("datasetName", SMOKE_DATASET);
    form.append("data", new Blob([SMOKE_TEXT], { type: "text/markdown" }), SMOKE_FILE);
    form.append("external_metadata", JSON.stringify([{ doc_id: SMOKE_DOC_ID }]));
    const added = await call("POST", "/api/v1/add", { form, timeoutMs: o.addTimeoutMs });
    if (!added.ok) throw new SmokeError(`add failed (${await reason(added)})`);

    // 4. listing
    const listed = await call("GET", `/api/v1/datasets/${encodeURIComponent(datasetId)}/data`);
    if (!listed.ok) throw new SmokeError(`list data failed (${await reason(listed)})`);
    const payload = await listed.json().catch(() => null);
    const items = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
    if (items.length < 1) throw new SmokeError("the dataset listing is empty after add");
    const ids = items.flatMap(docIds);
    if (ids.length && !ids.includes(SMOKE_DOC_ID)) {
      throw new SmokeError(`the listed document carries doc_id ${JSON.stringify(ids[0])}, expected ${SMOKE_DOC_ID}`);
    }
  } catch (e) {
    failure = e instanceof SmokeError ? e.message : `request failed (${/** @type {Error} */ (e).name})`;
  } finally {
    // 5. cleanup, best effort, before any exit
    if (datasetId) {
      try {
        const del = await call("DELETE", `/api/v1/datasets/${encodeURIComponent(datasetId)}`);
        if (del.ok) h.ok(`deleted smoke dataset ${SMOKE_DATASET}`);
        else h.warn(`could not delete smoke dataset ${SMOKE_DATASET} (${await reason(del)}); delete it by hand: DELETE ${base}/api/v1/datasets/${datasetId}`);
      } catch (e) {
        h.warn(`could not delete smoke dataset ${SMOKE_DATASET} (${/** @type {Error} */ (e).name}); delete it by hand: DELETE ${base}/api/v1/datasets/${datasetId}`);
      }
    }
  }

  if (failure) {
    h.die(`Cognee smoke test failed: ${failure}. Check: ${logs} (and LLM_API_KEY in cognee.env)`);
    return;
  }
  h.ok(`Cognee accepted and listed a document in dataset ${SMOKE_DATASET}`);
  h.info(RECALL_SKIPPED);
}
