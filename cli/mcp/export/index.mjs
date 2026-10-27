/** Provider PMM export adapters (orchestrator: cli/mcp/portability.mjs). */

import { exportCognee } from "./cognee.mjs";
import { exportHindsight } from "./hindsight.mjs";
import { exportMem0 } from "./mem0.mjs";

export { exportHindsight } from "./hindsight.mjs";
export { exportMem0 } from "./mem0.mjs";
export { exportCognee } from "./cognee.mjs";
export { cogneeDatasetName } from "./cognee-dataset-name.mjs";

/**
 * @param {string} provider
 * @param {Record<string, unknown>} ctx
 * @param {Record<string, unknown>} args
 * @param {typeof fetch} fetchFn
 */
export async function runProviderExport(provider, ctx, args, fetchFn) {
  if (provider === "mem0") {
    const scopeBank = String(args.bank || "openmem-mcp").trim() || "openmem-mcp";
    return exportMem0(ctx, { user_id: scopeBank }, fetchFn);
  }
  if (provider === "hindsight") return exportHindsight(ctx, args, fetchFn);
  if (provider === "cognee") return exportCognee(ctx, args, fetchFn);
  throw new Error(`export not supported for provider ${provider}`);
}
