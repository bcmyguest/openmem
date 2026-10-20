import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { envValue } from "./paths.mjs";
import { ok, warn, die } from "./log.mjs";
import { confirm } from "./prompts.mjs";

/**
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on("error", () => resolve(false));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * Keep a host port when it is free (or held by this compose project); otherwise offer
 * the next free one.
 * @param {import("./run-wizard.mjs").WizardContext} ctx
 * @param {string} label
 * @param {number} port
 * @param {{ envVars?: string[] }} [opts] env var names that override the ports, for messages
 * @returns {Promise<number>}
 */
export async function choosePort(ctx, label, port, opts = {}) {
  const envVars = opts.envVars || [];
  if (await portFree(port)) {
    ok(`${label} port ${port} is free`);
    return port;
  }
  let owner = "";
  const ps = spawnSync(
    "docker",
    ["ps", "--filter", `publish=${port}`, "--format", "{{.Label \"com.docker.compose.project\"}}"],
    { encoding: "utf8" },
  );
  if (ps.status === 0 && ps.stdout) {
    owner = ps.stdout.split("\n").find((l) => l.trim())?.trim() || "";
  }
  if (owner === ctx.project) {
    ok(`${label} port ${port} is held by this project (${ctx.project})`);
    return port;
  }
  if (owner) warn(`${label} port ${port} is held by compose project '${owner}'`);
  else warn(`${label} port ${port} is held by another process`);

  let alt = 0;
  for (let i = 1; i <= 50; i++) {
    if (await portFree(port + i)) {
      alt = port + i;
      break;
    }
  }
  if (!alt) {
    die(
      `no free port near ${port}${envVars.length ? `; set ${envVars.join(" or ")} and` : ";"} rerun`,
    );
  }
  if (await confirm(ctx, `Use port ${alt} for the ${label} instead (saved to ${path.join(ctx.repoRoot, ".env")})?`, "y")) {
    return alt;
  }
  die(`free port ${port}${envVars.length ? ` (or set ${envVars.join(" / ")})` : ""} and rerun ./setup`);
}

/**
 * Resolve one host port from the active provider's manifest (`compose.hostPortEnv`,
 * `compose.defaultHostPort`): process env, then the stack .env, then the default.
 * Exports the chosen port in process.env under the manifest's variable name.
 * @param {import("./run-wizard.mjs").WizardContext} ctx
 * @param {string} [label]
 * @returns {Promise<number>}
 */
export async function resolveHostPort(ctx, label) {
  const compose = ctx.memoryProvider?.compose || {};
  const envName = compose.hostPortEnv;
  if (!envName) die(`provider ${ctx.memoryProvider?.id} declares no compose.hostPortEnv`);
  const wanted =
    process.env[envName] ||
    envValue(path.join(ctx.repoRoot, ".env"), envName) ||
    String(compose.defaultHostPort ?? 8888);
  if (!/^\d+$/.test(wanted)) die(`${envName} must be a port number`);
  const port = await choosePort(ctx, label || `${ctx.memoryProvider.label} API`, Number(wanted), {
    envVars: [envName],
  });
  process.env[envName] = String(port);
  return port;
}
