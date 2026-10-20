/**
 * Step "8. Coding-agent plugin", Hindsight half: ensure ~/.hindsight/coding-agent.json
 * exists (seeded from the tracked template when missing) and check that its optInPaths
 * cover the indexed roots. Machine-local keys such as notebooklmAccess must live in a
 * real file — never in the repo template — so we do not replace a materialised config
 * with a symlink (that used to wipe notebooklmAccess.enabled after step 6).
 * The meta wizard installs the plugin package itself from the manifest.
 */
import fs from "node:fs";
import path from "node:path";
import { realpathSync } from "node:fs";
import { installNotebooklmMcp } from "./notebooklm-mcp-install.mjs";
import { setNotebooklmAccessEnabled } from "../../../wizard/lib/notebooklm-agent-access.mjs";
import { ensureState } from "./state.mjs";

/** @typedef {import("../../../wizard/lib/provider-wizard/helpers.mjs").ProviderWizardHelpers} Helpers */

function realpathSafe(p) {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** @param {string} filePath */
function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/** True when notebooklm.yml opts the sync service in. */
function notebooklmSyncEnabled(ctx) {
  const yml = ctx.notebookFile || path.join(ctx.home, ".config/hindsight/notebooklm.yml");
  if (!fs.existsSync(yml)) return false;
  return /^enabled:\s*true\b/m.test(fs.readFileSync(yml, "utf8"));
}

/**
 * Seed or keep a real coding-agent.json. Symlinks to the tracked template are left as-is
 * when already correct; a regular file is never replaced with a symlink (preserves
 * notebooklmAccess and other machine settings).
 *
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
    // Keep the real file. Replacing it with a symlink to the shipped template drops
    // notebooklmAccess.enabled and breaks the NotebookLM MCP on the next Cursor start.
    h.ok(`${ctx.agentJson} is a machine-local file (not replaced with a symlink)`);
    return;
  }
  // Missing: copy the template into a real file so later notebooklmAccess writes never
  // land in the repo.
  if (ctx.dry) {
    h.info(`[dry-run] create ${ctx.agentJson} from ${rel} (regular file, not a symlink)`);
    return;
  }
  fs.mkdirSync(path.dirname(ctx.agentJson), { recursive: true });
  const seeded = readJsonSafe(target) || {
    serverMode: "self-hosted",
    apiUrl: "http://127.0.0.1:8888",
    optInOnly: true,
    optInPaths: [],
    mapPathToBank: {},
    notebooklmAccess: { enabled: false, banks: ["*"] },
  };
  fs.writeFileSync(ctx.agentJson, `${JSON.stringify(seeded, null, 2)}\n`);
  h.ok(`created ${ctx.agentJson} from ${rel}`);
}

/**
 * If NotebookLM sync is on, keep notebooklmAccess.enabled and the Cursor MCP entry.
 * Materialises a symlink into a real file first so the flag never writes into the template.
 *
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
async function ensureNotebooklmAccess(ctx, h) {
  if (!notebooklmSyncEnabled(ctx)) return;
  const templatePath = path.join(ctx.repoRoot, "config/coding-agent.json");
  if (ctx.dry) {
    h.info(`[dry-run] keep notebooklmAccess.enabled=true (NotebookLM sync is on)`);
    return;
  }
  const result = setNotebooklmAccessEnabled(ctx.agentJson, templatePath, true);
  h.ok(
    `notebooklmAccess.enabled=true in ${ctx.agentJson}` +
      (result.action === "materialized" ? " (materialized symlink → regular file)" : ""),
  );
  await installNotebooklmMcp(
    { home: ctx.home, repoRoot: ctx.repoRoot, agentJson: ctx.agentJson, dry: false },
    h,
  );
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
  // Prefer the live agent config (real file or symlink target). Never write
  // machine paths into the shipped template unless that is what agentJson resolves to.
  let target = ctx.agentJson;
  try {
    if (fs.lstatSync(ctx.agentJson).isSymbolicLink()) {
      target = realpathSafe(fs.readlinkSync(ctx.agentJson));
    }
  } catch {
    target = path.join(ctx.repoRoot, "config/coding-agent.json");
  }
  if (!fs.existsSync(target)) {
    target = path.join(ctx.repoRoot, "config/coding-agent.json");
  }
  const cfg = JSON.parse(fs.readFileSync(target, "utf8"));
  if (!Array.isArray(cfg.optInPaths)) cfg.optInPaths = [];
  const opt = cfg.optInPaths.map((p) => path.resolve(h.expandHome(p, ctx.home)));
  const missing = [];
  for (const root of indexRoots(ctx, h)) {
    const abs = path.resolve(root);
    const covered = opt.some((p) => abs === p || abs.startsWith(`${p.replace(/\/$/, "")}/`));
    if (!covered) missing.push(root);
  }
  if (!missing.length) {
    h.ok(`optInPaths in ${target} covers the indexed roots`);
    return;
  }
  h.warn("optInPaths does not cover:");
  for (const m of missing) h.info(`    ${m}`);
  if (ctx.dry) {
    h.info(`[dry-run] offer to add these to optInPaths in ${target}`);
    return;
  }
  const tracked = path.join(ctx.repoRoot, "config/coding-agent.json");
  const prompt =
    realpathSafe(target) === realpathSafe(tracked)
      ? "Add them to optInPaths in the tracked file config/coding-agent.json (shows in git status)?"
      : `Add them to optInPaths in ${target}?`;
  if (await h.confirm(ctx, prompt, "n")) {
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
  // Step 6 may have set notebooklmAccess on a real file; linkAgentConfig used to
  // symlink over it. Re-assert after linking, then register the MCP.
  await ensureNotebooklmAccess(ctx, h);
  if (!notebooklmSyncEnabled(ctx)) {
    await installNotebooklmMcp(ctx, h);
  }
}
