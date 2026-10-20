import fs from "node:fs";
import path from "node:path";

/**
 * Compose profiles for the active provider + optional extras (Ollama, NotebookLM).
 *
 * @param {{ memoryProvider?: { compose?: { profile?: string } }, extraComposeProfiles?: string[] }} ctx
 * @returns {string[]}
 */
export function composeProfiles(ctx) {
  const compose = ctx.memoryProvider?.compose || {};
  const profiles = [];
  if (compose.profile) profiles.push(compose.profile);
  for (const p of ctx.extraComposeProfiles || []) {
    if (typeof p === "string" && p && !profiles.includes(p)) profiles.push(p);
  }
  return profiles;
}

/**
 * Arguments for `docker` that run a compose subcommand for the active provider.
 *
 * Every compose call in the wizard goes through here so the manifest's
 * `compose.profile` and `compose.files` apply uniformly (up, build, run, down, ps).
 * With no `compose.files`, no -f flag is added and compose auto-loads compose.yaml
 * and compose.override.yaml from the stack root. With `compose.files`, the list is
 * compose.yaml, compose.override.yaml (when present), then the extra files.
 *
 * Extra profiles (compose Ollama, NotebookLM) come from `ctx.extraComposeProfiles`.
 * Docker Compose unions CLI `--profile` with `COMPOSE_PROFILES` from `.env`, so
 * `composeSpawnOptions` overrides that env var to the same list — otherwise `.env`
 * can start NotebookLM while the wizard intentionally omitted it (e.g. during smoke).
 *
 * @param {{ project: string, repoRoot: string, memoryProvider?: { compose?: { profile?: string, files?: string[] } }, extraComposeProfiles?: string[] }} ctx
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
  for (const p of composeProfiles(ctx)) args.push("--profile", p);
  return [...args, ...rest];
}

/** `docker ...` as the wizard prints it in descriptions. */
export function composeCommandText(ctx, ...rest) {
  return `docker ${composeArgs(ctx, ...rest).join(" ")}`;
}

/**
 * Spawn options for compose calls: cwd is the stack root; COMPOSE_PROFILES matches
 * the `--profile` flags so `.env` cannot enable extra profiles behind the wizard's back.
 */
export function composeSpawnOptions(ctx) {
  return {
    cwd: ctx.repoRoot,
    env: {
      ...process.env,
      COMPOSE_PROFILES: composeProfiles(ctx).join(","),
    },
  };
}
