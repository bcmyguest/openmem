/** Cognee's one host port (COGNEE_PORT, default 8766; the container listens on 8000). */
import { ensureState } from "./state.mjs";

/** @typedef {import("../../../wizard/lib/provider-wizard/helpers.mjs").ProviderWizardHelpers} Helpers */

/**
 * Choose the host port from the manifest (env, then the stack .env, then 8766), offer the
 * next free one when it is taken, and export it for compose and the stack setup script.
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export async function resolvePorts(ctx, h) {
  ensureState(ctx);
  const port = String(await h.resolveHostPort(ctx, "Cognee API"));
  ctx.portCognee = port;
  process.env.COGNEE_PORT = port;
  ctx.cogneeUrl = `http://127.0.0.1:${port}`;
}
