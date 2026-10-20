import { spawnSync } from "node:child_process";
import { info } from "./log.mjs";

/**
 * Run a command, or print it when the context is a dry run. Exits the process on failure.
 * @param {import("./run-wizard.mjs").WizardContext} ctx
 * @param {string} description
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ env?: Record<string, string>, cwd?: string }} [opts] extra environment, working directory
 */
export async function act(ctx, description, cmd, args, opts = {}) {
  if (ctx.dry) {
    info(`[dry-run] ${description}`);
    return;
  }
  info(description);
  const r = spawnSync(cmd, args, {
    stdio: "inherit",
    env: { ...process.env, ...(opts.env || {}) },
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

/**
 * Like act(), with extra environment variables for the child.
 * @param {import("./run-wizard.mjs").WizardContext} ctx
 * @param {string} description
 * @param {string} cmd
 * @param {string[]} args
 * @param {Record<string, string>} extraEnv
 */
export async function actWithEnv(ctx, description, cmd, args, extraEnv) {
  await act(ctx, description, cmd, args, { env: extraEnv });
}

export function commandExists(name) {
  const r = spawnSync("command", ["-v", name], { shell: true, stdio: "ignore" });
  return r.status === 0;
}
