/** Hindsight's two host ports: the API and the control plane. */
import path from "node:path";
import { ensureState } from "./state.mjs";

/** @typedef {import("../../../wizard/lib/provider-wizard/helpers.mjs").ProviderWizardHelpers} Helpers */

const ENV_VARS = ["HINDSIGHT_PORT", "HINDSIGHT_CP_PORT"];

/**
 * Pick the API and control-plane ports (env, then the stack .env, then 8888/9999) and
 * export them in process.env for compose.
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export async function resolvePorts(ctx, h) {
  ensureState(ctx);
  const stackEnv = path.join(ctx.repoRoot, ".env");
  const api =
    process.env.HINDSIGHT_PORT || h.envValue(stackEnv, "HINDSIGHT_PORT") || "8888";
  const cp =
    process.env.HINDSIGHT_CP_PORT || h.envValue(stackEnv, "HINDSIGHT_CP_PORT") || "9999";
  if (!/^\d+$/.test(api) || !/^\d+$/.test(cp)) {
    h.die("HINDSIGHT_PORT and HINDSIGHT_CP_PORT must be port numbers");
  }
  ctx.portApi = String(await h.choosePort(ctx, "Hindsight API", Number(api), { envVars: ENV_VARS }));
  ctx.portCp = String(await h.choosePort(ctx, "control plane", Number(cp), { envVars: ENV_VARS }));
  process.env.HINDSIGHT_PORT = ctx.portApi;
  process.env.HINDSIGHT_CP_PORT = ctx.portCp;
  ctx.hindsightUrl = `http://127.0.0.1:${ctx.portApi}`;
}
