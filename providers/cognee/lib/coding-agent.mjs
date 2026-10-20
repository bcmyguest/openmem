/**
 * Cognee has no coding-agent plugin package. This hook tells the operator how agents talk
 * to the Cognee REST API on the loopback port (docs, add, cognify, search).
 */
import { currentPort, ensureState } from "./state.mjs";

/** @typedef {import("../../../wizard/lib/provider-wizard/helpers.mjs").ProviderWizardHelpers} Helpers */

/**
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export async function setupCodingAgent(ctx, h) {
  ensureState(ctx);
  const url = ctx.cogneeUrl || `http://127.0.0.1:${currentPort(ctx)}`;
  h.info(`Cognee has no coding-agent plugin package. Agents talk to it over REST at ${url}:`);
  h.info(`  OpenAPI docs     ${url}/docs`);
  h.info(`  Health           GET  ${url}/health`);
  h.info(`  Ingest           POST ${url}/api/v1/add  (multipart; then cognify)`);
  h.info(`  Cognify          POST ${url}/api/v1/cognify`);
  h.info(`  Search           POST ${url}/api/v1/search`);
  h.info("  Auth is off in this stack (loopback only). Set X-Api-Key only if you enable auth in compose.");
}
