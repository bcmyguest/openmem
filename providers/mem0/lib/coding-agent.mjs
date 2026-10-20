/**
 * Step "8. Coding-agent plugin", mem0 half: there is no npx pluginPackage for the
 * self-hosted REST server. Print concrete SDK / MCP / direct-REST paths so the step
 * is never a silent skip. The meta wizard still prints "no coding-agent plugin"
 * when pluginPackage is null; this hook follows with the real guidance.
 */
import { ensureState } from "./state.mjs";
import { displayUrl, resolveApiUrl, urlProblem } from "./url.mjs";

/** @typedef {import("../../../wizard/lib/provider-wizard/helpers.mjs").ProviderWizardHelpers} Helpers */

const SDK_DOCS = "https://docs.mem0.ai/open-source/python-quickstart";
const MCP_DOCS = "https://docs.mem0.ai/open-source/features/mcp-server";
const REST_DOCS = "https://docs.mem0.ai/open-source/features/rest-api";
const OPERATOR = "providers/mem0/OPERATOR.md";

/**
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export async function setupCodingAgent(ctx, h) {
  ensureState(ctx);
  const raw = resolveApiUrl(ctx, h);
  const base = urlProblem(raw) ? "(set MEM0_API_URL)" : displayUrl(raw);

  h.info("mem0 has no coding-agent pluginPackage; use the self-hosted server directly:");
  h.info(`  1. SDK  — pip install mem0ai, point Memory at ${base} (see ${SDK_DOCS})`);
  h.info(`  2. MCP  — run mem0's MCP server against the same URL (see ${MCP_DOCS})`);
  h.info(
    `  3. REST — POST ${base}/memories and POST ${base}/search with X-API-Key` +
      ` (see ${REST_DOCS}; stack wiring in ${OPERATOR})`,
  );
  h.ok("coding-agent: documented SDK / MCP / REST paths (pluginPackage remains null)");
}
