/**
 * Cognee has no coding-agent plugin package. This hook prints REST paths and registers
 * the read-only Cognee MCP in ~/.cursor/mcp.json (health + search).
 */
import { installCogneeMcp } from "./cognee-mcp-install.mjs";
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
  h.info("Read-only Cursor MCP: cognee_health / cognee_search (cli/cognee-mcp.mjs).");
  await installCogneeMcp(ctx, h);
}
