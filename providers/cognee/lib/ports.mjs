/** Cognee's one host port (COGNEE_PORT, default 8766; the container listens on 8000). */
import path from "node:path";
import { ensureState } from "./state.mjs";

/** @typedef {import("../../../wizard/lib/provider-wizard/helpers.mjs").ProviderWizardHelpers} Helpers */

/**
 * Choose the host port (environment, TOML table, stack .env, the port saved in
 * wizard.conf, then 8766), offer the next free one when it is taken, and export it for
 * compose and the stack setup script. wizard.conf is read here because `hydrate` runs after
 * the ports are resolved.
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export async function resolvePorts(ctx, h) {
  ensureState(ctx);
  if (!process.env.COGNEE_PORT && !h.envValue(path.join(ctx.repoRoot, ".env"), "COGNEE_PORT")) {
    const saved = h.envValue(ctx.wizardConf, "COGNEE_PORT");
    if (/^\d+$/.test(saved)) process.env.COGNEE_PORT = saved;
  }
  const port = String(await h.resolveHostPort(ctx, "Cognee API"));
  ctx.portCognee = port;
  process.env.COGNEE_PORT = port;
  ctx.cogneeUrl = `http://127.0.0.1:${port}`;
}
