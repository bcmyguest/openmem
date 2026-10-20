import fs from "node:fs";
import path from "node:path";

/**
 * Arguments for `docker` that run a compose subcommand for the active provider.
 *
 * Every compose call in the wizard goes through here so the manifest's
 * `compose.profile` and `compose.files` apply uniformly (up, build, run, down, ps).
 * With no `compose.files`, no -f flag is added and compose auto-loads compose.yaml
 * and compose.override.yaml from the stack root. With `compose.files`, the list is
 * compose.yaml, compose.override.yaml (when present), then the extra files.
 *
 * @param {{ project: string, repoRoot: string, memoryProvider?: { compose?: { profile?: string, files?: string[] } } }} ctx
 * @param {...string} rest the compose subcommand and its arguments
 * @returns {string[]}
 */
export function composeArgs(ctx, ...rest) {
  const compose = ctx.memoryProvider?.compose || {};
  const args = ["compose", "-p", ctx.project];
  const extra = Array.isArray(compose.files) ? compose.files : [];
  if (extra.length) {
    args.push("-f", "compose.yaml");
    if (fs.existsSync(path.join(ctx.repoRoot, "compose.override.yaml"))) {
      args.push("-f", "compose.override.yaml");
    }
    for (const f of extra) args.push("-f", f);
  }
  if (compose.profile) args.push("--profile", compose.profile);
  return [...args, ...rest];
}

/** `docker ...` as the wizard prints it in descriptions. */
export function composeCommandText(ctx, ...rest) {
  return `docker ${composeArgs(ctx, ...rest).join(" ")}`;
}

/** spawn options for compose calls: compose files are resolved in the stack root. */
export function composeSpawnOptions(ctx) {
  return { cwd: ctx.repoRoot };
}
