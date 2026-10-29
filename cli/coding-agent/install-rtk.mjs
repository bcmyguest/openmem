/**
 * Wire rtk (https://github.com/rtk-ai/rtk) command rewriting through rtk's own installer.
 * rtk adds PreToolUse-style entries and preserves other hooks, so it coexists with
 * OpenMem's SessionStart / prompt / Stop entries. `rtk init` is idempotent.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** `rtk init` arguments per agent, from rtk's README and src/hooks/init. */
export const RTK_INIT_ARGS = Object.freeze({
  // Without --auto-patch, rtk asks before editing settings.json and answers "no" off a TTY.
  "claude-code": ["init", "-g", "--auto-patch"],
  codex: ["init", "-g", "--codex"],
  "cursor-cli": ["init", "-g", "--agent", "cursor"],
  opencode: ["init", "-g", "--opencode"],
});

/** First executable `name` on `env.PATH`, or null. */
export function findOnPath(name, env = process.env) {
  for (const dir of String(env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch { /* keep looking */ }
  }
  return null;
}

/**
 * Run `rtk init` for each selected agent rtk supports. Missing rtk is a no-op.
 * rtk's OpenCode integration targets OpenCode 1, so OpenCode 2 is skipped.
 */
export function installRtk({ agents, env = process.env, dry = false, h, spawn = spawnSync, opencodeMajor = 1 }) {
  const rtk = findOnPath("rtk", env);
  if (!rtk) return { rtk: null, ran: [] };
  const ran = [];
  for (const agentId of agents) {
    const args = RTK_INIT_ARGS[agentId];
    if (!args) continue;
    if (agentId === "opencode" && opencodeMajor >= 2) {
      h?.info(`opencode: skipped rtk (rtk supports OpenCode 1; found OpenCode ${opencodeMajor})`);
      continue;
    }
    if (dry) {
      h?.info(`[dry-run] ${rtk} ${args.join(" ")}`);
      continue;
    }
    const r = spawn(rtk, args, { stdio: ["ignore", "inherit", "inherit"], env });
    if (r.status === 0) {
      h?.ok(`${agentId}: rtk command rewriting (rtk ${args.join(" ")})`);
      ran.push(agentId);
    } else {
      h?.warn(`${agentId}: rtk ${args.join(" ")} exited ${r.status ?? r.error?.message}; run it by hand`);
    }
  }
  return { rtk, ran };
}
