/**
 * Hindsight model routing: how the LiteLLM proxy in front of Hindsight reaches an LLM
 * (lemond, Ollama or a custom OpenAI-compatible URL), plus the reflect-model question and
 * `lemonade pull`. The meta wizard knows none of this; it calls configureModelRouting.
 */
import { applyRoute, litellmConfig, saveConf } from "./litellm-routes.mjs";
import { ollamaModelNames, openAiModelIds } from "./probe.mjs";
import {
  backendDefault,
  ensureState,
  OLLAMA_COMPOSE_API_BASE,
  OLLAMA_HOST_API_BASE,
  storedOr,
} from "./state.mjs";

/** @typedef {import("../../../wizard/lib/provider-wizard/helpers.mjs").ProviderWizardHelpers} Helpers */

/**
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
async function pickBackend(ctx, h) {
  const def = backendDefault(ctx, h);
  if (ctx.yes) {
    ctx.backend = def;
    return;
  }
  h.info("Pick a backend first; only that server is contacted.");
  h.info("1) lemond   2) ollama   3) custom OpenAI-compatible URL");
  const defNum = def === "lemond" ? "1" : def === "ollama" ? "2" : "3";
  const choice = await h.ask(ctx, "Model backend (1-3)", defNum);
  switch (choice) {
    case "1":
      ctx.backend = "lemond";
      break;
    case "2":
      ctx.backend = "ollama";
      break;
    case "3":
      ctx.backend = "custom";
      break;
    default:
      h.die("choose 1, 2 or 3");
  }
}

/** @param {Record<string, any>} ctx @param {Helpers} h */
function probeLemond(ctx, h) {
  const body = h.curlJson(`${ctx.lemondBase}/v1/models`);
  ctx.lemondJson = body;
  ctx.lemondNames = openAiModelIds(typeof body === "object" ? body : null);
}

/** @param {Record<string, any>} ctx @param {Helpers} h */
function probeOllama(ctx, h) {
  const body = h.curlJson(`${ctx.ollamaBase}/api/tags`);
  ctx.ollamaJson = body;
  ctx.ollamaNames = ollamaModelNames(body);
}

/** @param {string[]} names @param {Helpers} h */
function showModels(names, h) {
  for (const n of names) h.info(`      ${n}`);
}

/** @param {Record<string, any>} ctx @param {Helpers} h */
async function askReflectModel(ctx, h) {
  const machine = h.loadMachineEnv(ctx.repoRoot);
  const defaultAnswer =
    process.env.PM_REFLECT_MODEL ||
    machine.PM_REFLECT_MODEL ||
    storedOr(ctx, h, ctx.backend, "MEMORY_REFLECT_MODEL", "");
  const answer = await h.ask(
    ctx,
    "Separate reflect model (type shipped for the shipped reflect route)",
    defaultAnswer,
  );
  if (answer === "" || answer === "shipped") ctx.reflectModel = "";
  else ctx.reflectModel = answer;
}

/** @param {Record<string, any>} ctx @param {Helpers} h */
async function pullLemondModels(ctx, h) {
  if (!ctx.lemondJson) return;
  const names = new Set();
  for (const line of litellmConfig(ctx).split("\n")) {
    const m = line.match(/^\s*model: openai\/(.+)/);
    if (m) names.add(m[1]);
  }
  for (const name of names) {
    if (!name || ctx.lemondNames.includes(name)) continue;
    h.warn(`${name} is not downloaded in lemond`);
    if (await h.confirm(ctx, `Run lemonade pull ${name} now?`, "y")) {
      if (h.commandExists("lemonade")) {
        await h.act(ctx, `lemonade pull ${name}`, "lemonade", ["pull", name]);
      } else h.warn(`lemonade is not on PATH: run 'lemonade pull ${name}' on this host`);
    }
  }
}

/** @param {Record<string, any>} ctx @param {Helpers} h */
async function chooseLemond(ctx, h) {
  ctx.apiBase = "http://host.docker.internal:13305/v1";
  const machine = h.loadMachineEnv(ctx.repoRoot);
  const defaultModel = storedOr(
    ctx,
    h,
    "lemond",
    "MEMORY_MODEL",
    process.env.PM_DEFAULT_MODEL || machine.PM_DEFAULT_MODEL || ctx.lemondDefaultModel,
  );
  if (!ctx.lemondJson) {
    h.warn(`lemond is not answering on ${ctx.lemondBase}; the model list is unavailable`);
  } else if (!ctx.lemondNames.includes(ctx.lemondDefaultModel)) {
    h.warn(`${ctx.lemondDefaultModel} is not listed by lemond`);
  }
  ctx.model = await h.ask(ctx, "lemond model id", defaultModel);
  await askReflectModel(ctx, h);
  await pullLemondModels(ctx, h);
}

/** @param {Record<string, any>} ctx @param {Helpers} h */
async function chooseOllama(ctx, h) {
  const machine = h.loadMachineEnv(ctx.repoRoot);
  const defaultModel = storedOr(
    ctx,
    h,
    "ollama",
    "MEMORY_MODEL",
    process.env.PM_DEFAULT_MODEL || machine.PM_DEFAULT_MODEL || ctx.ollamaDefaultModel,
  );
  if (ctx.ollamaJson) {
    ctx.ollamaInCompose = false;
    ctx.apiBase = OLLAMA_HOST_API_BASE;
  } else {
    h.warn(`Ollama is not answering on ${ctx.ollamaBase}`);
    const useDocker = await h.confirm(
      ctx,
      "Ollama is not on this host. Run it in Docker (compose profile ollama)?",
      "y",
    );
    ctx.ollamaInCompose = useDocker;
    ctx.apiBase = useDocker ? OLLAMA_COMPOSE_API_BASE : OLLAMA_HOST_API_BASE;
    if (useDocker) {
      h.info("LiteLLM will call http://ollama:11434; the wizard pulls the model after the stack starts.");
    }
  }
  ctx.model = await h.ask(ctx, "Ollama model", defaultModel);
  await askReflectModel(ctx, h);
}

/** @param {Record<string, any>} ctx @param {Helpers} h */
async function chooseCustom(ctx, h) {
  const defaultBase = storedOr(ctx, h, "custom", "MEMORY_API_BASE", ctx.customDefaultBase);
  const defaultModel = storedOr(ctx, h, "custom", "MEMORY_MODEL", ctx.lemondDefaultModel);
  h.info("The litellm container calls this URL. Host services use host.docker.internal.");
  h.info("Examples: lemond http://host.docker.internal:13305/v1 ; Meridian http://host.docker.internal:3456/v1");
  ctx.apiBase = await h.ask(ctx, "OpenAI-compatible base URL", defaultBase);
  ctx.model = await h.ask(ctx, "Model id the server serves", defaultModel);
  await askReflectModel(ctx, h);
}

/**
 * Step "3. Model backend": choose lemond, Ollama or a custom URL, write the LiteLLM route
 * override when the choice differs from the shipped routes, and record it in wizard.conf.
 * With the Clack UI done (ctx.skipBackendStep) the answers come from PM_BACKEND,
 * PM_DEFAULT_MODEL, MEMORY_API_BASE and PM_REFLECT_MODEL instead.
 *
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export async function chooseModelBackend(ctx, h) {
  ensureState(ctx);
  h.step("3. Model backend");
  if (ctx.skipBackendStep) {
    if (!process.env.PM_BACKEND) h.die("PM_BACKEND missing with WIZARD_SKIP_BACKEND_STEP");
    if (!process.env.PM_DEFAULT_MODEL) h.die("PM_DEFAULT_MODEL missing with WIZARD_SKIP_BACKEND_STEP");
    ctx.backend = process.env.PM_BACKEND;
    ctx.model = process.env.PM_DEFAULT_MODEL;
    ctx.apiBase = process.env.MEMORY_API_BASE || "";
    ctx.reflectModel = process.env.PM_REFLECT_MODEL || "";
    ctx.ollamaInCompose = process.env.MEMORY_OLLAMA_IN_COMPOSE === "1";
    if (ctx.backend === "ollama" && !ctx.apiBase) {
      ctx.apiBase = ctx.ollamaInCompose ? OLLAMA_COMPOSE_API_BASE : OLLAMA_HOST_API_BASE;
    }
    h.ok(`backend ${ctx.backend}, model ${ctx.model} (setup UI)`);
    await applyRoute(ctx, h);
    saveConf(ctx, h);
    return;
  }
  await pickBackend(ctx, h);
  switch (ctx.backend) {
    case "lemond":
      probeLemond(ctx, h);
      if (ctx.lemondJson) {
        h.ok(`lemond answers on ${ctx.lemondBase}`);
        showModels(ctx.lemondNames, h);
      } else h.info(`lemond: not answering on ${ctx.lemondBase}`);
      await chooseLemond(ctx, h);
      break;
    case "ollama":
      probeOllama(ctx, h);
      if (ctx.ollamaJson) {
        h.ok(`Ollama answers on ${ctx.ollamaBase}`);
        showModels(ctx.ollamaNames, h);
      } else h.info(`Ollama: not answering on ${ctx.ollamaBase}`);
      await chooseOllama(ctx, h);
      break;
    case "custom":
      await chooseCustom(ctx, h);
      break;
    default:
      h.die(`unknown backend ${ctx.backend}`);
  }
  h.ok(`backend ${ctx.backend}, model ${ctx.model}`);
  await applyRoute(ctx, h);
  saveConf(ctx, h);
}
