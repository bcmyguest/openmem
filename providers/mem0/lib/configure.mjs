/**
 * Step "3. mem0 server URL and API key" (the hook is still named configureModelRouting).
 * mem0 v1 is URL-only: this asks for the REST server URL and the API key the indexer sends,
 * keeps the key in the mode 600 env file and never anywhere else. Keys can also be placed in
 * that file by hand.
 */
import path from "node:path";
import { applyConfig, configToml } from "./config.mjs";
import { dirTooOpen, fileMode, keyProblem, readKey, tooOpen, writeKey } from "./env-file.mjs";
import { capturedKey, captureKeyFromEnv } from "./secret.mjs";
import { ensureState, envFileProblem, resolveEnvFile } from "./state.mjs";
import { displayUrl, resolveApiUrl, urlProblem } from "./url.mjs";

/** @typedef {import("../../../wizard/lib/provider-wizard/helpers.mjs").ProviderWizardHelpers} Helpers */

/**
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export async function configureUrlAndKey(ctx, h) {
  const state = ensureState(ctx);
  h.step("3. mem0 server URL and API key");
  const interactive = !ctx.yes && !ctx.skipBackendStep;
  if (ctx.skipBackendStep) h.info("mem0 URL and key come from the setup UI (environment)");

  // URL.
  let raw = resolveApiUrl(ctx, h);
  if (interactive) {
    raw = String(await h.ask(ctx, "mem0 REST server URL (as this host sees it)", raw)).trim().replace(/\/+$/, "");
  }
  const urlIssue = urlProblem(raw);
  if (urlIssue) {
    h.problem(ctx, `mem0 API URL: ${urlIssue}`);
    return;
  }
  const url = displayUrl(raw);
  state.apiUrl = url;
  state.url = url;
  process.env.MEM0_API_URL = url;
  h.ok(`mem0 server ${url} (an external server you run; this stack does not start it)`);

  // Key file.
  const envFile = resolveEnvFile(ctx, h);
  const fileIssue = envFileProblem(envFile);
  if (fileIssue) {
    h.problem(ctx, fileIssue);
    return;
  }
  const existing = readKey(envFile);
  // Normally captured by the init hook (before any child process starts); this covers a caller
  // that skipped init and is a no-op once the variables are gone.
  captureKeyFromEnv();
  const key = capturedKey();
  if (key) h.info("using the API key from the environment");

  if (key) {
    const keyIssue = keyProblem(key);
    if (keyIssue) {
      h.problem(ctx, keyIssue);
      return;
    }
    if (ctx.dry) {
      h.info(`[dry-run] write MEM0_API_KEY to ${envFile} (mode 600, directory mode 700)`);
    } else {
      const result = writeKey(envFile, key);
      if (result === "unchanged") h.ok(`kept ${envFile} (same key, mode 600)`);
      else h.ok(`${result === "created" ? "created" : "updated"} ${envFile} with MEM0_API_KEY (mode 600)`);
    }
  } else if (existing) {
    h.ok(`kept the API key already in ${envFile}`);
    if (tooOpen(envFile)) {
      h.warn(`${envFile} is group/other accessible (mode ${fileMode(envFile).toString(8)}); run: chmod 600 ${envFile}`);
    }
  } else {
    // No prompt here: helpers.ask echoes what is typed. The setup UI (Clack) asks with a masked prompt.
    h.info(
      `no API key given. A server with auth enabled (the default) needs one: put MEM0_API_KEY=<key> in ${envFile} (mode 600), ` +
        "or rerun with MEM0_API_KEY (or PM_MEM0_API_KEY) in the environment under --yes. " +
        "A server run with AUTH_DISABLED does not need a key.",
    );
  }
  if (dirTooOpen(envFile)) {
    h.warn(`${path.dirname(envFile)} is accessible to group or others; run: chmod 700 ${path.dirname(envFile)}`);
  }

  const login = ctx.memoryProvider?.wizardHooks?.delegates?.login;
  if (login?.run?.length) {
    h.info(`optional, run it yourself: ${login.run.join(" ")} (native mem0 CLI login)`);
  }

  // Non-secret state: wizard.conf (+ config.toml) record the URL only.
  if (ctx.dry) h.info(`[dry-run] record MEM0_API_URL in ${ctx.wizardConf} and [memory.mem0] in config.toml`);
  else h.saveWizardConf(ctx, { MEM0_API_URL: url }, { pmSections: configToml(ctx, url) });
}

/**
 * Clack front end: ask the URL and (masked) key, hand them to the wizard through the
 * environment and skip the wizard's own prompts.
 * @param {{ repoRoot: string, home: string, wizardConf: string, pmMerged?: Record<string, unknown> }} ctx
 * @param {typeof import("@clack/prompts")} ui
 * @param {Helpers} h
 * @returns {Promise<Record<string, string>>}
 */
export async function clackSetup(ctx, ui, h) {
  const stub = /** @type {Record<string, any>} */ (ctx);
  ensureState(stub);
  applyConfig(stub);
  const current = resolveApiUrl(stub, h);
  const existing = readKey(resolveEnvFile(stub, h));

  const typed = await ui.text({
    message: "mem0 REST server URL (as this host sees it)",
    placeholder: current,
    defaultValue: current,
    validate: (v) => urlProblem(String(v || "").trim().replace(/\/+$/, "") || current) || undefined,
  });
  if (ui.isCancel(typed)) {
    ui.cancel("Setup cancelled.");
    process.exit(0);
  }
  const url = String(typed || "").trim().replace(/\/+$/, "") || current;

  const secret = await ui.password({
    message: existing
      ? "mem0 API key (empty keeps the one in the env file)"
      : "mem0 API key (empty if the server has auth disabled)",
    validate: (v) => keyProblem(String(v || "").trim()) || undefined,
  });
  if (ui.isCancel(secret)) {
    ui.cancel("Setup cancelled.");
    process.exit(0);
  }

  /** @type {Record<string, string>} */
  const handoff = { WIZARD_SKIP_BACKEND_STEP: "1", MEM0_API_URL: url };
  const key = String(secret || "").trim();
  if (key) handoff.PM_MEM0_API_KEY = key;
  ui.note("Next: Docker, indexing, and starting the stack.", "mem0 configured");
  return handoff;
}
