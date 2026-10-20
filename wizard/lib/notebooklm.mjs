/**
 * NotebookLM opt-in during setup: install the CLI if needed, run `notebooklm login`
 * (browser) when there is no valid session, then inject NOTEBOOKLM_HOME so host
 * commands and wizard.conf agree with the compose bind mount (~/.config/notebooklm).
 * After sync is enabled, optionally opt in coding-agent MCP access (notebooklm_list_banks /
 * notebooklm_search).
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { step, info, ok, warn } from "./log.mjs";
import { act, commandExists } from "./exec.mjs";
import { confirm } from "./prompts.mjs";
import { upsertWizardConf } from "./wizard-conf.mjs";
import { setNotebooklmAccessEnabled } from "./notebooklm-agent-access.mjs";
import { installNotebooklmMcp } from "../../providers/hindsight/lib/notebooklm-mcp-install.mjs";

/** @typedef {import("./run-wizard.mjs").WizardContext} WizardContext */

const MCP_CONFIRM =
  "Allow coding agents to query NotebookLM banks via MCP (notebooklm_list_banks / notebooklm_search)?";

/** @param {WizardContext} ctx */
function codingAgentPaths(ctx) {
  const agentPath = ctx.agentJson || path.join(ctx.home, ".hindsight", "coding-agent.json");
  const templatePath = path.join(ctx.repoRoot, "config/coding-agent.json");
  return { agentPath, templatePath };
}

/**
 * After NotebookLM sync was enabled this run: opt-in MCP access (default yes).
 * @param {WizardContext} ctx
 */
export async function offerNotebooklmMcpAccess(ctx) {
  const allow = await confirm(ctx, MCP_CONFIRM, "y");
  const { agentPath, templatePath } = codingAgentPaths(ctx);
  const h = { info, ok, warn };

  if (!allow) {
    if (ctx.dry) {
      info(`[dry-run] leave notebooklmAccess.enabled false; skip MCP merge (${agentPath})`);
      return false;
    }
    if (fs.existsSync(agentPath)) {
      try {
        const st = fs.lstatSync(agentPath);
        if (st.isFile() || st.isSymbolicLink()) {
          setNotebooklmAccessEnabled(agentPath, templatePath, false);
          ok(`notebooklmAccess.enabled=false in ${agentPath}`);
        }
      } catch (err) {
        warn(`could not clear notebooklmAccess.enabled: ${err instanceof Error ? err.message : err}`);
      }
    } else {
      info("notebooklmAccess left disabled (no coding-agent.json yet)");
    }
    return false;
  }

  if (ctx.dry) {
    const plan = setNotebooklmAccessEnabled(agentPath, templatePath, true, { dry: true });
    info(
      `[dry-run] ${plan.action} ${agentPath} with notebooklmAccess.enabled=true; merge notebooklm MCP into ~/.cursor/mcp.json`,
    );
    return true;
  }

  const result = setNotebooklmAccessEnabled(agentPath, templatePath, true);
  ok(
    `notebooklmAccess.enabled=true in ${agentPath}` +
      (result.action === "materialized" ? " (copied from symlink → regular file)" : ""),
  );
  await installNotebooklmMcp(
    { home: ctx.home, repoRoot: ctx.repoRoot, agentJson: agentPath, dry: false },
    h,
  );
  ok("Restart Cursor Agent so it picks up the notebooklm MCP");
  return true;
}

/** Host path the compose service bind-mounts as /data/notebooklm. */
export function notebooklmHome(ctx) {
  return path.join(ctx.home, ".config/notebooklm");
}

/** Env for every host `notebooklm` child: NOTEBOOKLM_HOME points at the shared cookie dir. */
export function notebooklmEnv(ctx) {
  return { ...process.env, NOTEBOOKLM_HOME: notebooklmHome(ctx) };
}

/**
 * Persist NOTEBOOKLM_HOME into the process env and wizard.conf (compose already mounts the path).
 * @param {WizardContext} ctx
 */
export function injectNotebooklmHome(ctx) {
  const home = notebooklmHome(ctx);
  process.env.NOTEBOOKLM_HOME = home;
  upsertWizardConf(ctx, { NOTEBOOKLM_HOME: home });
  ok(`NOTEBOOKLM_HOME=${home} (process env + wizard.conf)`);
}

/**
 * @param {WizardContext} ctx
 * @returns {boolean}
 */
export function notebooklmAuthOk(ctx) {
  if (!commandExists("notebooklm")) return false;
  const check = spawnSync("notebooklm", ["auth", "check", "--test", "--json"], {
    env: notebooklmEnv(ctx),
    stdio: "ignore",
  });
  return check.status === 0;
}

/**
 * Install notebooklm-py + Playwright Chromium via uv when the CLI is missing.
 * @param {WizardContext} ctx
 * @returns {Promise<boolean>} true when `notebooklm` is on PATH afterwards
 */
export async function ensureNotebooklmCli(ctx) {
  if (commandExists("notebooklm")) return true;
  if (!commandExists("uv")) {
    warn("uv is not on PATH; install uv, then rerun setup to enable NotebookLM");
    return false;
  }
  if (ctx.dry) {
    info(`[dry-run] uv tool install ${ctx.notebooklmPkg} && playwright install chromium`);
    return false;
  }
  info(`installing ${ctx.notebooklmPkg} (includes Playwright Chromium)`);
  await act(ctx, `uv tool install ${ctx.notebooklmPkg}`, "uv", ["tool", "install", ctx.notebooklmPkg]);
  await act(
    ctx,
    "playwright install chromium for notebooklm-py",
    "uv",
    ["tool", "run", "--from", ctx.notebooklmPkg, "python", "-m", "playwright", "install", "chromium"],
  );
  if (!commandExists("notebooklm")) {
    warn("notebooklm still not on PATH after install (check ~/.local/bin)");
    return false;
  }
  return true;
}

/**
 * Open the Google sign-in browser via notebooklm-py. Stdio is inherited so the
 * operator can complete login; no separate "are you done?" prompt.
 * @param {WizardContext} ctx
 * @returns {Promise<boolean>}
 */
export async function runNotebooklmLogin(ctx) {
  if (ctx.dry) {
    info("[dry-run] notebooklm login (opens a browser; NOTEBOOKLM_HOME set)");
    return false;
  }
  if (ctx.yes) {
    warn("skipping notebooklm login under --yes (needs a browser); log in interactively or rerun without --yes");
    return false;
  }
  if (!process.stdin.isTTY) {
    warn("skipping notebooklm login (no TTY); run setup interactively once");
    return false;
  }
  fs.mkdirSync(notebooklmHome(ctx), { recursive: true, mode: 0o700 });
  info("opening Google sign-in for NotebookLM (complete it in the browser window)…");
  const r = spawnSync("notebooklm", ["login"], {
    env: notebooklmEnv(ctx),
    stdio: "inherit",
  });
  return r.status === 0;
}

/**
 * @param {WizardContext} ctx
 * @param {(c: WizardContext) => void} enableNotebooklm
 */
export async function setupNotebooklm(ctx, enableNotebooklm) {
  step("6. NotebookLM sync (optional, default no)");
  if (!(await confirm(ctx, "Enable the NotebookLM sync? It stores a Google session cookie on this machine", "n"))) {
    info("skipped; the service stays off");
    return;
  }
  if (ctx.dry) {
    info("[dry-run] install notebooklm-py if needed, login if auth fails, inject NOTEBOOKLM_HOME, enable notebooklm.yml");
    await offerNotebooklmMcpAccess(ctx);
    return;
  }

  fs.mkdirSync(notebooklmHome(ctx), { recursive: true, mode: 0o700 });
  injectNotebooklmHome(ctx);

  if (!(await ensureNotebooklmCli(ctx))) return;

  if (notebooklmAuthOk(ctx)) {
    ok("NotebookLM session already valid");
    enableNotebooklm(ctx);
    await offerNotebooklmMcpAccess(ctx);
    return;
  }

  info("no valid NotebookLM session yet; starting login…");
  const loggedIn = await runNotebooklmLogin(ctx);
  if (!loggedIn) {
    warn(`login did not finish; ${ctx.notebookFile} is unchanged. Rerun setup when ready`);
    return;
  }
  if (!notebooklmAuthOk(ctx)) {
    warn(`auth check failed after login; ${ctx.notebookFile} is unchanged`);
    return;
  }
  ok("NotebookLM login ok");
  enableNotebooklm(ctx);
  await offerNotebooklmMcpAccess(ctx);
}
