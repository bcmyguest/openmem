/**
 * Step "9. Coding-agent plugin", mem0 half: there is no npx pluginPackage for the
 * self-hosted REST server. Print concrete SDK / MCP / direct-REST paths, then
 * optionally merge the mem0 MCP into ~/.cursor/mcp.json (--yes or confirm).
 */
import { installMem0Mcp } from "./mcp-install.mjs";
import { ensureState } from "./state.mjs";
import { displayUrl, resolveApiUrl, urlProblem } from "./url.mjs";

/** @typedef {import("../../../wizard/lib/provider-wizard/helpers.mjs").ProviderWizardHelpers} Helpers */

const SDK_DOCS = "https://docs.mem0.ai/open-source/python-quickstart";
const MCP_PACKAGE = "https://www.npmjs.com/package/@yeyuan98/mem0-mcp";
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
  h.info(
    `  2. MCP  — MEMORY_PROVIDER=mem0 npm run install-mcp -- --yes` +
      ` (npx @yeyuan98/mem0-mcp via cli/mem0-mcp.mjs; see ${MCP_PACKAGE} and ${OPERATOR})`,
  );
  h.info(
    `  3. REST — POST ${base}/memories and POST ${base}/search with X-API-Key` +
      ` (see ${REST_DOCS}; stack wiring in ${OPERATOR})`,
  );

  const codeRoot = ctx.packageRoot || ctx.repoRoot;
  const stackRoot = ctx.repoRoot;
  const wantMcp =
    Boolean(ctx.yes) ||
    (await h.confirm(ctx, "Register mem0 MCP in ~/.cursor/mcp.json now?", "y"));
  if (wantMcp) {
    await installMem0Mcp(
      {
        home: ctx.home,
        repoRoot: codeRoot,
        stackRoot,
        dry: Boolean(ctx.dry),
        env: process.env,
      },
      h,
    );
  } else {
    h.info("skip MCP merge; later: MEMORY_PROVIDER=mem0 npm run install-mcp -- --yes");
  }

  h.ok("coding-agent: documented SDK / MCP / REST paths (pluginPackage remains null)");
}
