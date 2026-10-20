#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadManifest } from "../../wizard/lib/providers/registry.mjs";
import {
  callProviderHook,
  listDelegateCommands,
  PROVIDER_PHASES,
  runProviderPhase,
} from "../../wizard/lib/provider-wizard/run-steps.mjs";
import {
  createHelpers,
  HELPERS_API_VERSION,
} from "../../wizard/lib/provider-wizard/helpers.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let fails = 0;
function check(desc, ok) {
  if (ok) console.log(`ok    ${desc}`);
  else {
    console.log(`FAIL  ${desc}`);
    fails++;
  }
}

/** Source without comments, so a JSDoc type reference is not mistaken for an import. */
function code(file) {
  return fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function listFiles(dir, ext) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listFiles(p, ext));
    else if (ext.some((e) => ent.name.endsWith(e))) out.push(p);
  }
  return out;
}

async function loadWizard(id) {
  const manifest = loadManifest(id);
  const modPath = path.join(root, "providers", id, manifest.wizardHooks.module);
  check(`${id} wizard.mjs exists`, fs.existsSync(modPath));
  return import(pathToFileURL(modPath).href);
}

const hindsight = await loadWizard("hindsight");
check("hindsight exports configureModelRouting", typeof hindsight.configureModelRouting === "function");
check("hindsight exports afterProvider", typeof hindsight.afterProvider === "function");
for (const phase of [
  "init",
  "resolvePorts",
  "setupEnv",
  "stackEnv",
  "hydrate",
  "configToml",
  "summary",
  "extendValidation",
  "setupCodingAgent",
  "clackSetup",
]) {
  check(`hindsight exports ${phase}`, typeof hindsight[phase] === "function");
}
for (const phase of ["prepareStackEnv", "migrateEnv", "setupNotices"]) {
  check(`hindsight exports ${phase} (scripts/setup.mjs)`, typeof hindsight[phase] === "function");
}

const mem0 = await loadWizard("mem0");
check("mem0 exports configureModelRouting", typeof mem0.configureModelRouting === "function");
const mem0Manifest = loadManifest("mem0");
check("mem0 declares login delegate", listDelegateCommands(mem0Manifest).includes("login"));

check("registry defines provider phases", Object.keys(PROVIDER_PHASES).length >= 5);
for (const phase of ["resolvePorts", "setupEnv", "summary", "smoke", "apiBase", "extendValidation"]) {
  check(`registry defines phase ${phase}`, PROVIDER_PHASES[phase] === phase);
}

// (iv) helpers API v2.
const helpers = createHelpers();
check("helpers apiVersion is 2", helpers.apiVersion === 2 && HELPERS_API_VERSION === 2);
for (const name of [
  "step", "ok", "warn", "die", "info", "ask", "confirm", "act", "actWithEnv", "commandExists",
  "loadMachineEnv", "curlJson", "curlGet", "curlRequest", "envValue", "expandHome", "ensureConfigDir",
  "portFree", "choosePort", "resolveHostPort", "composeArgs", "saveWizardConf", "runStackSetup", "apiBase",
]) {
  check(`helpers.${name} is a function`, typeof helpers[name] === "function");
}
check("helpers no longer expose chooseBackend", !("chooseBackend" in helpers) && !("fallback" in helpers));
check("helpers object is frozen", Object.isFrozen(helpers));
check(
  "createHelpers overrides one helper and keeps the rest",
  createHelpers({ info: () => "x" }).info() === "x" && createHelpers({ info: () => "x" }).apiVersion === 2,
);

// (ii) static checks: no import cycle, no Hindsight knowledge in the meta wizard.
const providerFiles = listFiles(path.join(root, "providers"), [".mjs", ".js"]);
const cyclic = providerFiles.filter((f) => /run-wizard/.test(code(f)));
check(
  "no file under providers/ imports run-wizard (hooks receive helpers)",
  cyclic.length === 0,
);
if (cyclic.length) for (const f of cyclic) console.log(`      ${path.relative(root, f)}`);
const fixtureProviders = path.join(root, "scripts/tests/fixtures/providers");
check(
  "fixture providers do not import run-wizard",
  listFiles(fixtureProviders, [".mjs"]).every((f) => !/run-wizard/.test(code(f))),
);

const runWizardSrc = fs.readFileSync(path.join(root, "wizard/lib/run-wizard.mjs"), "utf8");
check("run-wizard.mjs has no lemond/ollama/litellm text", !/lemond|ollama|litellm/i.test(runWizardSrc));
for (const f of ["run-wizard.mjs", "ports.mjs", "validate-setup.mjs"]) {
  const src = fs.readFileSync(path.join(root, "wizard/lib", f), "utf8");
  check(`${f} has no hindsight/HINDSIGHT_ text`, !/hindsight/i.test(src));
}
check(
  "run-wizard.mjs has no chooseBackend or fallback hook",
  !/chooseBackend|helpers\.fallback|fallback:/.test(runWizardSrc),
);
check(
  "Hindsight-only modules moved out of wizard/lib",
  !fs.existsSync(path.join(root, "wizard/lib/litellm-routes.mjs")) &&
    !fs.existsSync(path.join(root, "wizard/lib/probe.mjs")) &&
    fs.existsSync(path.join(root, "providers/hindsight/lib/litellm-routes.mjs")) &&
    fs.existsSync(path.join(root, "providers/hindsight/lib/probe.mjs")),
);

// (i) providers/hindsight owns the model flow and never calls chooseBackend.
const hindsightSrc = [
  fs.readFileSync(path.join(root, "providers/hindsight/wizard.mjs"), "utf8"),
  ...listFiles(path.join(root, "providers/hindsight/lib"), [".mjs"]).map((f) => fs.readFileSync(f, "utf8")),
].join("\n");
check("hindsight never references chooseBackend", !/\bchooseBackend\b/.test(hindsightSrc));
const flowSrc = fs.readFileSync(path.join(root, "providers/hindsight/lib/model-backend.mjs"), "utf8");
check("hindsight owns the lemond/ollama/custom flow", /chooseLemond/.test(flowSrc) && /chooseOllama/.test(flowSrc) && /chooseCustom/.test(flowSrc));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pm-hooks-"));
const envKeys = ["PM_BACKEND", "PM_DEFAULT_MODEL", "PM_REFLECT_MODEL", "MEMORY_API_BASE"];
const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
function resetEnv(extra = {}) {
  for (const k of envKeys) delete process.env[k];
  Object.assign(process.env, extra);
}

/**
 * Stubbed helpers: no process exits, no spawned commands, no real prompts.
 * `answers` maps a prompt substring to a reply; unmatched prompts take their default.
 */
function stubHelpers(home, { models = {}, answers = {} } = {}) {
  const calls = { act: [], saved: [], confirm: [], info: [], warn: [], step: [] };
  const h = createHelpers({
    step: (t) => calls.step.push(t),
    info: (m) => calls.info.push(m),
    ok: (m) => calls.info.push(`ok ${m}`),
    warn: (m) => calls.warn.push(m),
    die: (m) => {
      throw new Error(`die: ${m}`);
    },
    ask: async (_ctx, prompt, def) => {
      const hit = Object.keys(answers).find((k) => prompt.includes(k));
      return hit ? answers[hit] : def;
    },
    confirm: async (_ctx, prompt, def) => {
      calls.confirm.push(prompt);
      return def === "y";
    },
    act: async (_ctx, description, cmd, args) => calls.act.push([description, cmd, ...args]),
    commandExists: () => true,
    loadMachineEnv: () => ({}),
    curlJson: (url) => (url in models ? models[url] : null),
    ensureConfigDir: () => fs.mkdirSync(path.join(home, ".config/hindsight"), { recursive: true }),
    saveWizardConf: (_ctx, extra) => calls.saved.push(extra),
  });
  return { h, calls };
}

function freshCtx(name, extra = {}) {
  const home = path.join(tmp, name);
  const hs = path.join(home, ".config/hindsight");
  fs.mkdirSync(hs, { recursive: true });
  return {
    home,
    hsDir: hs,
    repoRoot: root,
    wizardConf: path.join(hs, "wizard.conf"),
    litellmOverride: path.join(hs, "litellm.yaml"),
    yes: true,
    dry: false,
    ...extra,
  };
}

const lemondModels = {
  "http://127.0.0.1:13305/v1/models": {
    data: [{ id: "Gemma-4-E2B-it-GGUF" }, { id: "gemma-4-E4B-it-GGUF-Q4_K_M" }],
  },
};

// --yes, default backend (lemond), shipped model: no override, conf records lemond.
resetEnv();
{
  const ctx = freshCtx("lemond-yes");
  const { h, calls } = stubHelpers(ctx.home, { models: lemondModels });
  await hindsight.configureModelRouting(ctx, h);
  check("--yes lemond: backend lemond", ctx.backend === "lemond");
  check("--yes lemond: shipped model", ctx.model === "Gemma-4-E2B-it-GGUF");
  check("--yes lemond: api base is the docker host URL", ctx.apiBase === "http://host.docker.internal:13305/v1");
  check("--yes lemond: model step announced", calls.step.includes("3. Model backend"));
  check("--yes lemond: no override file for the shipped model", !fs.existsSync(ctx.litellmOverride));
  check(
    "--yes lemond: wizard.conf keys saved through helpers.saveWizardConf",
    calls.saved.length === 1 &&
      calls.saved[0].MEMORY_BACKEND === "lemond" &&
      calls.saved[0].MEMORY_MODEL === "Gemma-4-E2B-it-GGUF" &&
      calls.saved[0].MEMORY_API_BASE === "http://host.docker.internal:13305/v1" &&
      calls.saved[0].MEMORY_REFLECT_MODEL === "",
  );
}

// --yes lemond with a model that lemond lacks: offers lemonade pull through helpers.act.
resetEnv({ PM_DEFAULT_MODEL: "Custom-Retain-GGUF" });
{
  const ctx = freshCtx("lemond-pull");
  const { h, calls } = stubHelpers(ctx.home, { models: lemondModels });
  await hindsight.configureModelRouting(ctx, h);
  check("lemond custom model: override written", fs.existsSync(ctx.litellmOverride));
  check(
    "lemond custom model: retain route uses it",
    /model: openai\/Custom-Retain-GGUF/.test(fs.readFileSync(ctx.litellmOverride, "utf8")),
  );
  check(
    "lemond custom model: lemonade pull via helpers.act",
    calls.act.some((a) => a[1] === "lemonade" && a.includes("Custom-Retain-GGUF")),
  );
}

// --yes ollama (host answering).
resetEnv({ PM_BACKEND: "ollama" });
{
  const ctx = freshCtx("ollama-yes");
  const { h, calls } = stubHelpers(ctx.home, {
    models: { "http://127.0.0.1:11434/api/tags": { models: [{ name: "gemma4:e2b" }] } },
  });
  await hindsight.configureModelRouting(ctx, h);
  check("--yes ollama: backend ollama", ctx.backend === "ollama");
  check("--yes ollama: shipped model", ctx.model === "gemma4:e2b");
  check("--yes ollama: api base", ctx.apiBase === "http://host.docker.internal:11434");
  check("--yes ollama: not in compose", ctx.ollamaInCompose === false);
  check("--yes ollama: conf saved", calls.saved[0]?.MEMORY_BACKEND === "ollama");
  check("--yes ollama: compose flag saved as 0", calls.saved[0]?.MEMORY_OLLAMA_IN_COMPOSE === "0");
}

// --yes ollama when host is down: default confirm is yes → compose Ollama.
resetEnv({ PM_BACKEND: "ollama" });
{
  const ctx = freshCtx("ollama-compose-yes");
  const { h, calls } = stubHelpers(ctx.home, { models: {} });
  await hindsight.configureModelRouting(ctx, h);
  check("--yes ollama down: compose mode", ctx.ollamaInCompose === true);
  check("--yes ollama down: api base is compose service", ctx.apiBase === "http://ollama:11434");
  check("--yes ollama down: override written for compose api_base", fs.existsSync(ctx.litellmOverride));
  const text = fs.readFileSync(ctx.litellmOverride, "utf8");
  check("--yes ollama down: route points at ollama service", text.includes("api_base: http://ollama:11434"));
  check("--yes ollama down: conf records compose", calls.saved[0]?.MEMORY_OLLAMA_IN_COMPOSE === "1");
}

// --yes custom: override file with the custom URL.
resetEnv({ PM_BACKEND: "custom" });
{
  const ctx = freshCtx("custom-yes");
  const { h, calls } = stubHelpers(ctx.home, { answers: { "base URL": "http://host.docker.internal:3456/v1", "Model id": "My-Model" } });
  await hindsight.configureModelRouting(ctx, h);
  check("--yes custom: backend custom", ctx.backend === "custom");
  check("--yes custom: model", ctx.model === "My-Model");
  const text = fs.existsSync(ctx.litellmOverride) ? fs.readFileSync(ctx.litellmOverride, "utf8") : "";
  check("--yes custom: override carries the URL and model", text.includes("api_base: http://host.docker.internal:3456/v1") && text.includes("model: openai/My-Model"));
  check("--yes custom: conf saved", calls.saved[0]?.MEMORY_BACKEND === "custom");
}

// Clack handoff (skipBackendStep): answers come from the environment, no probing.
resetEnv({
  PM_BACKEND: "lemond",
  PM_DEFAULT_MODEL: "Custom-Retain-GGUF",
  MEMORY_API_BASE: "http://host.docker.internal:13305/v1",
  PM_REFLECT_MODEL: "Other-Reflect-GGUF",
});
{
  const ctx = freshCtx("skip", { skipBackendStep: true });
  const { h, calls } = stubHelpers(ctx.home);
  await hindsight.configureModelRouting(ctx, h);
  check("skipBackendStep: values from env", ctx.backend === "lemond" && ctx.model === "Custom-Retain-GGUF" && ctx.reflectModel === "Other-Reflect-GGUF");
  check("skipBackendStep: announces the setup UI", calls.info.some((m) => m.includes("(setup UI)")));
  const text = fs.readFileSync(ctx.litellmOverride, "utf8");
  check("skipBackendStep: reflect route uses the reflect model", /model_name: memory-reflect\n\s+litellm_params:\n\s+model: openai\/Other-Reflect-GGUF/.test(text));
  check("skipBackendStep: conf saved with reflect model", calls.saved[0]?.MEMORY_REFLECT_MODEL === "Other-Reflect-GGUF");
}

// skipBackendStep without PM_BACKEND dies (stub die throws).
resetEnv();
{
  const ctx = freshCtx("skip-missing", { skipBackendStep: true });
  const { h } = stubHelpers(ctx.home);
  let msg = "";
  try {
    await hindsight.configureModelRouting(ctx, h);
  } catch (e) {
    msg = e.message;
  }
  check("skipBackendStep without PM_BACKEND dies", /PM_BACKEND missing/.test(msg));
}

// Dry run: nothing written, plan printed.
resetEnv({ PM_DEFAULT_MODEL: "Custom-Retain-GGUF" });
{
  const ctx = freshCtx("dry", { dry: true });
  const { h, calls } = stubHelpers(ctx.home, { models: lemondModels });
  await hindsight.configureModelRouting(ctx, h);
  check("dry run: no override and no conf written", !fs.existsSync(ctx.litellmOverride) && calls.saved.length === 0);
  check("dry run: plan lines printed", calls.info.some((m) => m.startsWith("[dry-run] write ")) && calls.info.some((m) => m.startsWith("[dry-run] record backend lemond")));
}

for (const k of envKeys) {
  if (savedEnv[k] === undefined) delete process.env[k];
  else process.env[k] = savedEnv[k];
}

// A provider without a hook for a phase is a clean no-op (no Hindsight fallback).
process.env.PM_PROVIDERS_DIR = fixtureProviders;
{
  const nohooks = loadManifest("nohooks");
  const ctx = { memoryProvider: nohooks, dry: true };
  let ranAny = false;
  for (const phase of Object.values(PROVIDER_PHASES)) {
    if (await runProviderPhase(ctx, phase, createHelpers())) ranAny = true;
  }
  check("provider without wizard.mjs: every phase is a no-op", !ranAny);
  const hook = await callProviderHook(ctx, PROVIDER_PHASES.configureModelRouting, createHelpers());
  check("callProviderHook reports ran=false and no value", hook.ran === false && hook.value === undefined);

  const hooked = loadManifest("hooked");
  const hctx = { memoryProvider: hooked, dry: true };
  check("hooked fixture: unimplemented phase is a no-op", (await runProviderPhase(hctx, PROVIDER_PHASES.afterStackHealthy, createHelpers())) === false);
  check("hooked fixture: implemented phase runs", (await runProviderPhase(hctx, PROVIDER_PHASES.extendValidation, createHelpers())) === true && hctx.validationChecks?.[0] === "hooked validation ran");
  const sum = await callProviderHook(hctx, PROVIDER_PHASES.summary, createHelpers());
  check("hooked fixture: summary hook returns its lines", sum.ran && sum.value.notes[0] === "Hooked note line");

  // Manifest path escapes are refused.
  const evil = { id: "hooked", wizardHooks: { module: "../nohooks/manifest.json" } };
  check("hook module outside the provider directory is ignored", (await callProviderHook({ memoryProvider: evil }, "summary", createHelpers())).ran === false);
}
delete process.env.PM_PROVIDERS_DIR;

fs.rmSync(tmp, { recursive: true, force: true });

if (fails) {
  console.log(`${fails} provider wizard hook test(s) failed`);
  process.exit(1);
}
console.log("all provider wizard hook tests passed");
