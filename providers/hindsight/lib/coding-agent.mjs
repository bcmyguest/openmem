/**
 * Step "8. Coding-agent plugin", Hindsight half: link ~/.hindsight/coding-agent.json to the
 * tracked config/coding-agent.json and check that its optInPaths cover the indexed roots.
 * The meta wizard installs the plugin package itself from the manifest.
 */
import fs from "node:fs";
import path from "node:path";
import { realpathSync } from "node:fs";
import { ensureState } from "./state.mjs";

/** @typedef {import("../../../wizard/lib/provider-wizard/helpers.mjs").ProviderWizardHelpers} Helpers */

function realpathSafe(p) {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
async function linkAgentConfig(ctx, h) {
  const rel = ctx.memoryProvider.codingAgent?.configTemplate;
  if (!rel) return;
  const target = path.join(ctx.repoRoot, rel);
  let stat;
  try {
    stat = fs.lstatSync(ctx.agentJson);
  } catch {
    stat = null;
  }
  if (stat?.isSymbolicLink()) {
    const dest = realpathSafe(fs.readlinkSync(ctx.agentJson));
    if (realpathSafe(dest) === realpathSafe(target)) {
      h.ok(`${ctx.agentJson} links to config/coding-agent.json`);
      return;
    }
    h.warn(`${ctx.agentJson} links to ${fs.readlinkSync(ctx.agentJson)}`);
    if (await h.confirm(ctx, "Repoint it to config/coding-agent.json?", "n")) {
      if (ctx.dry) h.info(`[dry-run] repoint ${ctx.agentJson}`);
      else {
        fs.unlinkSync(ctx.agentJson);
        fs.mkdirSync(path.dirname(ctx.agentJson), { recursive: true });
        fs.symlinkSync(target, ctx.agentJson);
        h.ok(`linked ${ctx.agentJson}`);
      }
    }
    return;
  }
  if (stat?.isFile()) {
    h.warn(`${ctx.agentJson} is a regular file`);
    if (await h.confirm(ctx, "Replace it with a symlink to config/coding-agent.json (the old file is kept as .bak)?", "n")) {
      if (ctx.dry) h.info(`[dry-run] replace ${ctx.agentJson} with a symlink`);
      else {
        fs.renameSync(ctx.agentJson, `${ctx.agentJson}.bak-${Date.now()}`);
        fs.mkdirSync(path.dirname(ctx.agentJson), { recursive: true });
        fs.symlinkSync(target, ctx.agentJson);
        h.ok(`linked ${ctx.agentJson}`);
      }
    }
    return;
  }
  if (ctx.dry) h.info(`[dry-run] link ${ctx.agentJson} -> ${target}`);
  else {
    fs.mkdirSync(path.dirname(ctx.agentJson), { recursive: true });
    fs.symlinkSync(target, ctx.agentJson);
    h.ok(`linked ${ctx.agentJson} -> ${target}`);
  }
}

/**
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 * @returns {string[]}
 */
function indexRoots(ctx, h) {
  const source = fs.existsSync(ctx.indexFile)
    ? ctx.indexFile
    : path.join(ctx.repoRoot, "config/index.yml");
  const roots = [];
  for (const line of fs.readFileSync(source, "utf8").split("\n")) {
    const m = line.match(/^\s*- path:\s*"?([^"]+)"?/);
    if (m) roots.push(h.expandHome(m[1].trim(), ctx.home));
  }
  return roots;
}

/**
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
async function checkOptIn(ctx, h) {
  const target = path.join(ctx.repoRoot, "config/coding-agent.json");
  const cfg = JSON.parse(fs.readFileSync(target, "utf8"));
  const opt = (cfg.optInPaths || []).map((p) => path.resolve(h.expandHome(p, ctx.home)));
  const missing = [];
  for (const root of indexRoots(ctx, h)) {
    const abs = path.resolve(root);
    const covered = opt.some((p) => abs === p || abs.startsWith(`${p.replace(/\/$/, "")}/`));
    if (!covered) missing.push(root);
  }
  if (!missing.length) {
    h.ok("optInPaths in config/coding-agent.json covers the indexed roots");
    return;
  }
  h.warn("optInPaths does not cover:");
  for (const m of missing) h.info(`    ${m}`);
  if (ctx.dry) {
    h.info("[dry-run] offer to add these to optInPaths in config/coding-agent.json");
    return;
  }
  if (
    await h.confirm(
      ctx,
      "Add them to optInPaths in the tracked file config/coding-agent.json (shows in git status)?",
      "n",
    )
  ) {
    for (const root of missing) {
      if (!cfg.optInPaths.includes(root)) cfg.optInPaths.push(root);
    }
    fs.writeFileSync(target, `${JSON.stringify(cfg, null, 2)}\n`);
    h.ok(`updated ${target}`);
  }
}

/**
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export async function setupCodingAgent(ctx, h) {
  ensureState(ctx);
  await linkAgentConfig(ctx, h);
  await checkOptIn(ctx, h);
}
