import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseWizardFlags } from "./parse-args.mjs";
import { loadMachineEnv } from "./load-machine-env.mjs";
import { step, info, ok, warn, die } from "./log.mjs";
import { envValue, ensureHsDir, expandHome, indexerStateDir } from "./paths.mjs";
import { curlGet, curlRequest } from "./curl.mjs";
import { ask, confirm } from "./prompts.mjs";
import { act, actWithEnv, commandExists } from "./exec.mjs";
import { buildService, snapshot } from "./docker-build.mjs";
import { composeArgs, composeCommandText, composeSpawnOptions } from "./compose.mjs";
import { INDEXER_BIN } from "./indexer.mjs";
import {
  DEFAULT_PROVIDER_ID,
  expandPath,
  listPlannedProviders,
  listSelectableProviders,
  providerApiBase,
  providerDefaultId,
  resolveProvider,
} from "./providers/registry.mjs";
import { validateMemorySetup } from "./validate-setup.mjs";
import { actionLabel, parseActionFromArgv } from "./wizard-action.mjs";
import { applyPmConfigEnv, loadPmConfig, syncPmConfig } from "./pm-config.mjs";
import { writeWizardConf } from "./wizard-conf.mjs";
import { createHelpers } from "./provider-wizard/helpers.mjs";
import {
  PROVIDER_PHASES,
  callProviderHook,
  runProviderPhase,
} from "./provider-wizard/run-steps.mjs";

/**
 * The meta wizard. It owns the provider-neutral steps (preflight, provider choice, shared
 * index.yml, NotebookLM, compose build/up/down, health, generic smoke, validation, config
 * sync) and calls the active provider's hooks for everything provider-specific. Provider
 * knowledge (model backends, secret files, ports, summary lines) lives in
 * providers/<id>/; see docs/provider-wizard-hooks.md. A provider without a hook for a
 * phase gets a clean no-op.
 */

/** @typedef {ReturnType<parseWizardFlags>} WizardContext & { memoryProvider?: import("./providers/registry.mjs").ProviderManifest } */

function confGet(ctx, key) {
  return envValue(ctx.wizardConf, key);
}

/** Helpers handed to provider hooks; the few that need meta state are overridden here. */
function providerHelpers() {
  return createHelpers({
    runStackSetup: (ctx, opts) => runSetupScript(ctx, opts),
    apiBase: (ctx) => resolveApiBase(ctx),
  });
}

/**
 * The provider's API base URL: its `apiBase` hook, else the manifest's port settings.
 * @param {WizardContext} ctx
 * @returns {Promise<string>}
 */
async function resolveApiBase(ctx) {
  const hook = await callProviderHook(ctx, PROVIDER_PHASES.apiBase, providerHelpers());
  if (hook.ran && hook.value) return String(hook.value);
  return providerApiBase(ctx, ctx.memoryProvider);
}

/** Run the provider's quiet `init` hook (context defaults, TOML/machine.env mapping). */
async function initProvider(ctx) {
  await runProviderPhase(ctx, PROVIDER_PHASES.init, providerHelpers());
}

async function hydrateFromWizardConf(ctx) {
  if (!fs.existsSync(ctx.wizardConf)) return false;
  const provider = confGet(ctx, "MEMORY_PROVIDER") || DEFAULT_PROVIDER_ID;
  ctx.providerId = provider;
  ctx.memoryProvider = resolveProvider(provider);
  await runProviderPhase(ctx, PROVIDER_PHASES.hydrate, providerHelpers());
  return true;
}

async function chooseProvider(ctx) {
  step("2. Memory provider");
  const machine = loadMachineEnv(ctx.repoRoot);
  const def = providerDefaultId(ctx, machine);
  const selectable = listSelectableProviders();
  if (ctx.skipBackendStep && process.env.MEMORY_PROVIDER) {
    ctx.providerId = process.env.MEMORY_PROVIDER;
    ctx.memoryProvider = resolveProvider(ctx.providerId);
    ok(`memory provider ${ctx.memoryProvider.label} (setup UI)`);
    return;
  }
  if (ctx.yes) {
    ctx.providerId = selectable.some((m) => m.id === def) ? def : DEFAULT_PROVIDER_ID;
  } else {
    info("Supported providers:");
    selectable.forEach((m, i) => info(`  ${i + 1}) ${m.id} — ${m.label} (${m.status})`));
    for (const m of listPlannedProviders()) {
      info(`  -) ${m.id} — planned (use ./setup when implemented)`);
    }
    const defIdx = String(selectable.findIndex((m) => m.id === def) + 1 || 1);
    const choice = await ask(ctx, "Memory provider (number)", defIdx);
    const idx = Number(choice) - 1;
    if (idx < 0 || idx >= selectable.length) die("pick a listed provider");
    ctx.providerId = selectable[idx].id;
  }
  const previous = confGet(ctx, "MEMORY_PROVIDER");
  ctx.memoryProvider = resolveProvider(ctx.providerId);
  if (previous && previous !== ctx.providerId && !ctx.yes) {
    if (
      !(await confirm(
        ctx,
        `Switch memory provider from ${previous} to ${ctx.providerId}? Existing data may not migrate automatically.`,
        "n",
      ))
    ) {
      ctx.providerId = previous;
      ctx.memoryProvider = resolveProvider(previous);
    }
  }
  ok(`memory provider ${ctx.memoryProvider.label}`);
}

/**
 * Run scripts/setup.mjs from the code root. It writes the stack .env and
 * compose.override.yaml in the stack root, then calls the provider's `prepareStackEnv`.
 * Defaults for the description and environment come from the provider's `stackEnv` hook.
 *
 * @param {WizardContext} ctx
 * @param {{ description?: string, args?: string[], env?: Record<string, string> }} [opts]
 */
async function runSetupScript(ctx, opts = {}) {
  const hook = await callProviderHook(ctx, PROVIDER_PHASES.stackEnv, providerHelpers());
  const spec = (hook.ran && hook.value) || {};
  const description =
    opts.description ?? spec.description ?? "scripts/setup.sh: write .env, compose.override.yaml";
  const env = {
    ...(opts.env ?? spec.env ?? {}),
    MEMORY_PROVIDER: ctx.memoryProvider.id,
    PM_STACK_ROOT: ctx.repoRoot,
    PM_PACKAGE_ROOT: ctx.packageRoot,
  };
  await actWithEnv(
    ctx,
    description,
    process.execPath,
    [path.join(ctx.packageRoot, "scripts", "setup.mjs"), ...(opts.args || [])],
    env,
  );
}

async function setupEnv(ctx) {
  step("4. Secrets and env");
  ensureHsDir(ctx);
  const stateDir = indexerStateDir(ctx);
  if (fs.existsSync(stateDir)) ok(`kept ${stateDir} (indexer state mount point)`);
  else if (ctx.dry) info(`[dry-run] create ${stateDir} (indexer state mount point)`);
  else {
    fs.mkdirSync(stateDir, { recursive: true });
    ok(`created ${stateDir} (indexer state mount point)`);
  }
  // A provider's setupEnv hook owns this step and calls helpers.runStackSetup itself.
  const handled = await runProviderPhase(ctx, PROVIDER_PHASES.setupEnv, providerHelpers());
  if (!handled) await runSetupScript(ctx);
}

function yamlList(key, csv) {
  const items = csv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!items.length) return `${key}: []\n`;
  return `${key}:\n${items.map((i) => `  - "${i}"`).join("\n")}\n`;
}

function renderIndex(root, depth, reposCsv, excludesCsv) {
  return (
    "# Written by ./setup. Replaces config/index.yml on this machine.\n" +
    "# Keys omitted here take built-in values; see README \"Source config: index.yml\".\n" +
    `roots:\n  - path: "${root}"\n    depth: ${depth}\n` +
    yamlList("repos", reposCsv) +
    "vaults:\n  auto: true\n  paths: []\n" +
    yamlList("exclude", excludesCsv)
  );
}

function findVaults(root, depth) {
  const out = [];
  const max = depth + 1;
  const walk = (dir, d) => {
    if (d > max) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const p = path.join(dir, ent.name);
      if (ent.name === ".obsidian") {
        out.push(dir);
        continue;
      }
      walk(p, d + 1);
    }
  };
  walk(root, 0);
  return out;
}

async function configureIndex(ctx) {
  step("5. Sources to index");
  if (fs.existsSync(ctx.indexFile)) {
    info(`found ${ctx.indexFile}`);
    if (!(await confirm(ctx, "Replace it with new answers?", "n"))) {
      ok(`kept ${ctx.indexFile}`);
      return;
    }
  }
  const root = await ask(ctx, "Root folder to scan for git repositories", "~");
  const depth = await ask(ctx, "Depth below the root", "3");
  const reposCsv = await ask(ctx, "Extra repository paths, comma-separated (empty for none)", "");
  const excludesCsv = await ask(
    ctx,
    "Exclude glob patterns on absolute paths, comma-separated (empty for none)",
    "",
  );
  if (ctx.dry) {
    info(`[dry-run] look for Obsidian vaults under ${root}, validate the config, then write ${ctx.indexFile}`);
    return;
  }
  const expanded = expandHome(root, ctx.home);
  const vaults = findVaults(expanded, Number(depth));
  if (vaults.length) {
    info("Obsidian vaults found (auto-discovered):");
    for (const v of vaults) info(`    ${v}`);
  } else info(`no Obsidian vaults found under ${root} within depth ${depth}`);

  const content = renderIndex(root, depth, reposCsv, excludesCsv);
  const tmp = path.join(os.tmpdir(), `wizard-index-${process.pid}.yml`);
  fs.writeFileSync(tmp, content);
  await buildService(ctx, "indexer", "personal-memory-indexer:local");
  const listingR = spawnSync(
    "docker",
    composeArgs(
      ctx,
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "-v",
      `${tmp}:/tmp/wizard-index.yml:ro`,
      "indexer",
      INDEXER_BIN,
      "--config",
      "/tmp/wizard-index.yml",
      "--list",
    ),
    { encoding: "utf8", ...composeSpawnOptions(ctx) },
  );
  fs.unlinkSync(tmp);
  if (listingR.status !== 0) die("the indexer rejected the config (message above)");
  const listing = listingR.stdout || "";
  const count = listing.split("\n").filter((l) => /^(repo|vault)\t/.test(l)).length;
  info(`the indexer selects ${count} source(s):`);
  for (const line of listing.split("\n").slice(0, 40)) {
    if (line) info(`    ${line}`);
  }
  if (!(await confirm(ctx, `Write this config to ${ctx.indexFile}?`, "y"))) {
    warn("not written");
    return;
  }
  ensureHsDir(ctx);
  if (fs.existsSync(ctx.indexFile)) {
    fs.copyFileSync(ctx.indexFile, `${ctx.indexFile}.bak-${Date.now()}`);
  }
  fs.writeFileSync(ctx.indexFile, content, { mode: 0o644 });
  ok(`wrote ${ctx.indexFile}`);
}

function enableNotebooklm(ctx) {
  ensureHsDir(ctx);
  if (fs.existsSync(ctx.notebookFile)) {
    let text = fs.readFileSync(ctx.notebookFile, "utf8");
    if (/^enabled:/m.test(text)) text = text.replace(/^enabled:.*/m, "enabled: true");
    else text += "\nenabled: true\n";
    fs.writeFileSync(ctx.notebookFile, text);
  } else {
    fs.writeFileSync(
      ctx.notebookFile,
      "# Per-machine overrides (changed keys only); see config/notebooklm.yml.\nenabled: true\n",
    );
  }
  ok(`enabled in ${ctx.notebookFile}; start with: docker compose -p ${ctx.project} --profile notebooklm up -d notebooklm`);
}

async function setupNotebooklm(ctx) {
  step("6. NotebookLM sync (optional, default no)");
  if (!(await confirm(ctx, "Enable the NotebookLM sync? It stores a Google session cookie on this machine", "n"))) {
    info("skipped; the service stays off");
    return;
  }
  console.log(`  Login steps (run on the host, once; README "NotebookLM"):
    mkdir -p ~/.config/notebooklm
    uv tool install '${ctx.notebooklmPkg}'
    NOTEBOOKLM_HOME=~/.config/notebooklm notebooklm login
    NOTEBOOKLM_HOME=~/.config/notebooklm notebooklm auth check --test --json`);
  if (ctx.dry) {
    info("[dry-run] after login: run auth check, then enable notebooklm.yml only if it passes");
    return;
  }
  if (!(await confirm(ctx, "Login is done; run the auth check now?", "n"))) {
    info("later: rerun ./setup after the login steps");
    return;
  }
  if (!commandExists("notebooklm")) {
    warn("notebooklm is not on PATH; finish the install step first");
    return;
  }
  const check = spawnSync(
    "notebooklm",
    ["auth", "check", "--test", "--json"],
    {
      env: { ...process.env, NOTEBOOKLM_HOME: path.join(ctx.home, ".config/notebooklm") },
      stdio: "ignore",
    },
  );
  if (check.status === 0) enableNotebooklm(ctx);
  else warn(`auth check failed; ${ctx.notebookFile} is unchanged. Log in again and rerun ./setup`);
}

async function waitHealth(ctx) {
  const p = ctx.memoryProvider;
  const base = await resolveApiBase(ctx);
  const healthPath = p.compose.healthPath || "/health";
  if (ctx.dry) {
    info(`[dry-run] wait for ${base}${healthPath}`);
    return;
  }
  for (let i = 0; i < 90; i++) {
    if (curlGet(`${base}${healthPath}`)) {
      ok(`${p.label} is healthy at ${base}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  die(
    `${p.label} is not healthy after about 6 minutes: docker compose -p ${ctx.project} logs ${p.compose.healthService || "memory"}`,
  );
}

async function deleteSmokeBank(ctx, base) {
  const p = ctx.memoryProvider;
  const bank = p.wizard.smokeBank || ctx.smokeBank;
  const delPath = expandPath(p, bank, p.wizard.deletePath);
  curlRequest(p.wizard.deleteMethod || "DELETE", `${base}${delPath}`);
}

/**
 * Smoke test. A provider's `smoke` hook replaces the manifest's HTTP template (for
 * flows that are asynchronous, multipart or not bank-shaped); otherwise the template in
 * manifest.wizard (retain, recall, delete) runs.
 */
async function smokeTest(ctx) {
  const handled = await runProviderPhase(ctx, PROVIDER_PHASES.smoke, providerHelpers());
  if (handled) return;
  const p = ctx.memoryProvider;
  const bank = p.wizard.smokeBank || ctx.smokeBank;
  const base = await resolveApiBase(ctx);
  if (ctx.dry) {
    info(`[dry-run] retain and recall one fact in bank ${bank}, then delete the bank`);
    return;
  }
  if (!p.wizard.retainPath || !p.wizard.recallPath) {
    info(`smoke test skipped (${p.label} has no wizard smoke steps yet)`);
    return;
  }
  const logServices = (p.compose.logServices?.length ? p.compose.logServices : null) ||
    (p.compose.healthService ? [p.compose.healthService] : []);
  const logs = composeCommandText(ctx, "logs", ...logServices);
  info(`smoke test: retain and recall in bank ${bank}`);
  const retainPath = expandPath(p, bank, p.wizard.retainPath);
  const retain = curlRequest(
    p.wizard.retainMethod || "POST",
    `${base}${retainPath}`,
    p.wizard.retainBody,
    600,
  );
  if (!retain) {
    await deleteSmokeBank(ctx, base);
    die(`retain failed: ${logs}`);
  }
  const recallPath = expandPath(p, bank, p.wizard.recallPath);
  const recall = curlRequest(
    p.wizard.recallMethod || "POST",
    `${base}${recallPath}`,
    p.wizard.recallBody,
    300,
  );
  await deleteSmokeBank(ctx, base);
  const needle = p.wizard.recallMustMatch || "heron";
  if (!new RegExp(needle, "i").test(recall)) {
    const hint = p.wizard.recallHint
      ? p.wizard.recallHint.replaceAll("{project}", ctx.project)
      : `(${logs})`;
    die(`recall did not return the smoke fact; ${hint}`);
  }
  ok(`retain and recall worked; bank ${bank} deleted`);
}

async function stackDown(ctx) {
  step("Stop the stack");
  info(`action: ${actionLabel("down")}`);
  const args = composeArgs(ctx, "down");
  await act(ctx, `docker ${args.join(" ")}`, "docker", args, composeSpawnOptions(ctx));
  ok(`compose project ${ctx.project} stopped`);
}

async function startStack(ctx) {
  step("7. Start the stack");
  await runSetupScript(ctx);
  await buildService(ctx, "indexer", "personal-memory-indexer:local");
  const up = composeArgs(ctx, "up", "-d", "--no-build");
  await act(ctx, `docker ${up.join(" ")}`, "docker", up, composeSpawnOptions(ctx));
  await waitHealth(ctx);
  if (ctx.smoke) await smokeTest(ctx);
  else info("smoke test skipped (--no-smoke)");
  await runProviderPhase(ctx, PROVIDER_PHASES.afterStackHealthy, providerHelpers());
}

async function setupCodingAgents(ctx) {
  step("8. Coding-agent plugin (optional)");
  const pkg = ctx.memoryProvider.codingAgent?.pluginPackage;
  const agents = ["claude", "codex", "opencode"].filter((n) => commandExists(n));
  if (!pkg) info(`no coding-agent plugin defined for ${ctx.memoryProvider.label}; step skipped`);
  else if (!agents.length) info("no claude, codex or opencode on PATH: plugin skipped");
  else {
    info(`detected: ${agents.join(" ")}`);
    if (await confirm(ctx, `Install the ${ctx.memoryProvider.label} plugin for them now (npx)?`, "n")) {
      await act(ctx, `npx --yes ${pkg} install ${agents.join(" ")}`, "npx", [
        "--yes",
        pkg,
        "install",
        ...agents,
      ]);
    } else {
      info(`skipped; later: npx --yes ${pkg} install ${agents.join(" ")}`);
    }
  }
  await runProviderPhase(ctx, PROVIDER_PHASES.setupCodingAgent, providerHelpers());
}

async function assertMemorySetup(ctx) {
  step("9. Validate memory setup");
  ctx.validationErrors = [];
  ctx.validationChecks = [];
  await runProviderPhase(ctx, PROVIDER_PHASES.extendValidation, providerHelpers());
  const result = validateMemorySetup(ctx);
  result.checks.push(...ctx.validationChecks);
  if (ctx.validationErrors?.length) {
    for (const e of ctx.validationErrors) result.errors.push(e);
    result.ok = result.errors.length === 0;
  }
  for (const c of result.checks) info(`check: ${c}`);
  if (result.ok) {
    ok("memory setup validation passed");
    return;
  }
  for (const e of result.errors) warn(e);
  if (ctx.dry) {
    info("[dry-run] validation errors ignored");
    return;
  }
  die("memory setup validation failed (fix the items above and rerun ./setup)");
}

/** config.toml tables the provider owns (empty for a provider without the hook). */
async function providerConfigSections(ctx) {
  const hook = await callProviderHook(ctx, PROVIDER_PHASES.configToml, providerHelpers());
  return (hook.ran && hook.value) || {};
}

async function summary(ctx) {
  step("Summary");
  info(`Memory provider: ${ctx.memoryProvider.label} (${ctx.memoryProvider.id})`);
  const hook = await callProviderHook(ctx, PROVIDER_PHASES.summary, providerHelpers());
  const sum = (hook.ran && hook.value) || {};
  info(`Running (compose project ${ctx.project}):`);
  for (const line of sum.running || []) info(line);
  info("Config files:");
  for (const line of sum.configFiles || []) info(line);
  if (fs.existsSync(ctx.indexFile)) info(`  ${ctx.indexFile} (sources)`);
  else info("  config/index.yml (shipped sources)");
  if (fs.existsSync(ctx.notebookFile)) info(`  ${ctx.notebookFile} (NotebookLM)`);
  info(`  ${ctx.wizardConf} (this wizard's backend choice)`);
  for (const line of sum.notes || []) info(line);
  const more = sum.logServices?.length ? `    (or: ${sum.logServices.join(", ")})` : "";
  info(`Logs:  ${composeCommandText(ctx, "logs", "-f", "indexer")}${more}`);
  info(`Stop:  ${composeCommandText(ctx, "down")}              (keeps the memory database)`);
  info(`Reset: ${composeCommandText(ctx, "down", "-v")}           (deletes the memory database)`);
}

async function checkPreflight(ctx) {
  step("1. Preflight");
  for (const tool of ["git", "curl", "docker"]) {
    if (!commandExists(tool)) die(`${tool} not found on PATH`);
  }
  const infoR = spawnSync("docker", ["info"], { stdio: "ignore" });
  if (infoR.status !== 0) {
    die(
      `docker is not usable by ${os.userInfo().username}. Fix: sudo usermod -aG docker ${os.userInfo().username}, then log out and back in`,
    );
  }
  const verR = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
  const verMatch = (verR.stdout || "").match(/version v?([0-9]+)\./);
  const major = Number(verMatch?.[1] || 0);
  if (major < 2) die("Docker Compose v2 is required (docker compose version). Install the compose plugin");
  ok(`docker and compose v${major} work without sudo; git and curl present`);
  ok(`host UID:GID is ${os.userInfo().uid}:${os.userInfo().gid}`);
  await runProviderPhase(ctx, PROVIDER_PHASES.resolvePorts, providerHelpers());
}

function loadMachineEnvStep(ctx) {
  const machinePath = path.join(ctx.repoRoot, "config/machine.env");
  if (fs.existsSync(machinePath)) ok(`machine profile ${machinePath}`);
  else if (fs.existsSync(path.join(ctx.repoRoot, "config/machine.env.example"))) {
    info("tip: cp config/machine.env.example config/machine.env for per-machine ./setup defaults");
  }
}

/** Count files and containers this run changed. */
async function changedCount(ctx, before) {
  const after = await snapshot(ctx);
  const beforeSet = new Set(before);
  let changed = 0;
  for (const line of after) if (!beforeSet.has(line)) changed++;
  return changed;
}

/**
 * @param {string} repoRoot the mutable stack root (compose files, .env, generated files)
 * @param {string[]} argv
 */
export async function runWizard(repoRoot, argv) {
  const ctx = parseWizardFlags(repoRoot, argv);
  // Provider manifests and hook modules load from the read-only code root; child scripts
  // (scripts/setup.mjs) inherit it.
  process.env.PM_PACKAGE_ROOT = ctx.packageRoot;
  const pm = loadPmConfig(ctx.home, repoRoot);
  ctx.pmMerged = pm.merged;
  if (pm.wroteFrom.length) ok(`toml config ${pm.wroteFrom.at(-1)}`);
  applyPmConfigEnv(pm.merged);
  ctx.action = parseActionFromArgv(argv);
  if (process.env.PM_PROJECT) ctx.project = process.env.PM_PROJECT;
  const machine = loadMachineEnv(repoRoot);
  ctx.providerId =
    process.env.MEMORY_PROVIDER ||
    machine.MEMORY_PROVIDER ||
    providerDefaultId(ctx, machine);
  ctx.memoryProvider = resolveProvider(ctx.providerId);
  await initProvider(ctx);
  loadMachineEnvStep(ctx);
  const before = await snapshot(ctx);
  if (ctx.dry) info("dry run: no files are written and no containers start");
  info(`wizard action: ${actionLabel(ctx.action)}`);
  const preflightProvider = ctx.memoryProvider.id;
  await checkPreflight(ctx);

  if (ctx.action === "down") {
    await stackDown(ctx);
    await summary(ctx);
    console.log("wizard: changed=0");
    return;
  }

  if (ctx.action === "up") {
    await chooseProvider(ctx);
    if (!(await hydrateFromWizardConf(ctx))) {
      die("no wizard.conf — run ./setup (configure) once before --up");
    }
    if (ctx.memoryProvider.id !== preflightProvider) {
      await initProvider(ctx);
      await runProviderPhase(ctx, PROVIDER_PHASES.resolvePorts, providerHelpers());
    }
    await runProviderPhase(ctx, PROVIDER_PHASES.beforeStack, providerHelpers());
    await startStack(ctx);
    await assertMemorySetup(ctx);
    await summary(ctx);
    console.log(`wizard: changed=${await changedCount(ctx, before)}`);
    return;
  }

  await chooseProvider(ctx);
  if (ctx.memoryProvider.id !== preflightProvider) {
    // The interactive pick differs from the id preflight used: set the new provider up.
    await initProvider(ctx);
    await runProviderPhase(ctx, PROVIDER_PHASES.resolvePorts, providerHelpers());
  }
  await runProviderPhase(ctx, PROVIDER_PHASES.afterProvider, providerHelpers());
  await runProviderPhase(ctx, PROVIDER_PHASES.configureModelRouting, providerHelpers());
  // A provider that saved wizard.conf itself (helpers.saveWizardConf) is left alone.
  if (!ctx.wizardConfWritten) writeWizardConf(ctx, {}, { pmSections: await providerConfigSections(ctx) });
  await setupEnv(ctx);
  await configureIndex(ctx);
  await setupNotebooklm(ctx);
  await runProviderPhase(ctx, PROVIDER_PHASES.beforeStack, providerHelpers());
  await startStack(ctx);
  await setupCodingAgents(ctx);
  await assertMemorySetup(ctx);
  syncPmConfig(ctx, await providerConfigSections(ctx));
  await summary(ctx);
  console.log(`wizard: changed=${await changedCount(ctx, before)}`);
}
