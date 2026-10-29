/**
 * Hindsight's questions for the Clack setup UI: model backend, models, reflect model
 * (or, for Meridian, its URL, key and the two Claude models).
 * The meta UI asks the provider-neutral questions (action, provider) and then calls
 * clackSetup; the returned environment is handed to the wizard so it skips its own
 * model prompts (WIZARD_SKIP_BACKEND_STEP).
 */
import { applyConfigEnv } from "./config.mjs";
import {
  bridgeReport,
  containerApiBase,
  dockerBridgeIp,
  existingMeridianKey,
  MERIDIAN_DEFAULT_BASE,
  MERIDIAN_GUIDE,
  MERIDIAN_REFLECT_DEFAULT,
  MERIDIAN_RETAIN_DEFAULT,
  normalizeMeridianBase,
  pickModel,
  probeMeridian,
} from "./meridian.mjs";
import { fetchJson, normalizeOpenAiBase, ollamaModelNames, openAiModelIds } from "./probe.mjs";
import {
  LEMOND_DEFAULT_MODEL,
  OLLAMA_COMPOSE_API_BASE,
  OLLAMA_DEFAULT_MODEL,
  OLLAMA_HOST_API_BASE,
} from "./state.mjs";

/** @typedef {import("../../../wizard/lib/provider-wizard/helpers.mjs").ProviderWizardHelpers} Helpers */

/**
 * @param {{ repoRoot: string, home: string, wizardConf: string, pmMerged?: Record<string, unknown> }} ctx
 * @param {typeof import("@clack/prompts")} ui the @clack/prompts module
 * @param {Helpers} h
 * @returns {Promise<Record<string, string>>} environment for the wizard process
 */
export async function clackSetup(ctx, ui, h) {
  const wizardConf = ctx.wizardConf;
  if (ctx.pmMerged) applyConfigEnv(ctx.pmMerged);
  /** @type {Record<string, string>} */
  const handoff = {};

  const lemondBase = process.env.LEMOND_BASE || "http://127.0.0.1:13305";
  handoff.LEMOND_BASE = lemondBase;

  const backendDefault =
    process.env.PM_BACKEND ||
    h.envValue(wizardConf, "MEMORY_BACKEND") ||
    "lemond";

  const backend = await ui.select({
    message: "Model backend",
    options: [
      {
        value: "lemond",
        label: "Lemonade (lemond)",
        hint: "local GGUFs on this host",
      },
      {
        value: "ollama",
        label: "Ollama",
        hint: "local models on this host",
      },
      {
        value: "custom",
        label: "OpenAI-compatible URL",
        hint: "hosted API, other",
      },
      {
        value: "meridian",
        label: "Claude subscription (Meridian)",
        hint: "a Meridian proxy you already run on this host",
      },
    ],
    initialValue: ["lemond", "ollama", "custom", "meridian"].includes(backendDefault)
      ? backendDefault
      : "lemond",
  });
  if (ui.isCancel(backend)) {
    ui.cancel("Setup cancelled.");
    process.exit(0);
  }

  let model = "";
  let apiBase = "";
  let reflectModel =
    process.env.PM_REFLECT_MODEL ||
    h.envValue(wizardConf, "MEMORY_REFLECT_MODEL") ||
    "";

  if (backend === "lemond") {
    const spin = ui.spinner();
    spin.start(`Checking lemond at ${lemondBase}`);
    const body = await fetchJson(`${lemondBase}/v1/models`);
    const ids = openAiModelIds(body);
    spin.stop(
      body ? `lemond answered (${ids.length} models)` : "lemond not reachable",
    );
    if (!body) {
      ui.log.warn(
        "Start lemonade (lemond) on this host, or pick custom / Ollama instead.",
      );
    }
    const defaultModel =
      h.envValue(wizardConf, "MEMORY_MODEL") ||
      LEMOND_DEFAULT_MODEL;
    if (ids.length > 0) {
      const picked = await ui.select({
        message: "Retain / consolidate model",
        options: ids.map((id) => ({ value: id, label: id })),
        initialValue: ids.includes(defaultModel) ? defaultModel : ids[0],
      });
      if (ui.isCancel(picked)) process.exit(0);
      model = /** @type {string} */ (picked);
    } else {
      const typed = await ui.text({
        message: "Retain / consolidate model id",
        placeholder: defaultModel,
        defaultValue: defaultModel,
      });
      if (ui.isCancel(typed)) process.exit(0);
      model = /** @type {string} */ (typed);
    }
    apiBase = "http://host.docker.internal:13305/v1";
  } else if (backend === "ollama") {
    const ollamaBase = "http://127.0.0.1:11434";
    const spin = ui.spinner();
    spin.start(`Checking Ollama at ${ollamaBase}`);
    const body = await fetchJson(`${ollamaBase}/api/tags`);
    const names = ollamaModelNames(body);
    spin.stop(
      body ? `Ollama answered (${names.length} models)` : "Ollama not reachable",
    );
    let ollamaInCompose = false;
    if (!body) {
      const useDocker = await ui.confirm({
        message: "Ollama is not on this host. Run it in Docker (compose profile ollama)?",
        active: "yes",
        inactive: "no",
        initialValue: true,
      });
      if (ui.isCancel(useDocker)) process.exit(0);
      ollamaInCompose = Boolean(useDocker);
      if (ollamaInCompose) {
        ui.log.info(
          "LiteLLM will call http://ollama:11434; the wizard pulls the model after the stack starts.",
        );
      } else {
        ui.log.warn(
          "Start Ollama on this host (OLLAMA_HOST on the Docker bridge), or rerun and pick Docker.",
        );
      }
    }
    const defaultModel =
      h.envValue(wizardConf, "MEMORY_MODEL") ||
      OLLAMA_DEFAULT_MODEL;
    if (names.length > 0) {
      const picked = await ui.select({
        message: "Retain / consolidate model",
        options: names.map((n) => ({ value: n, label: n })),
        initialValue: names.includes(defaultModel) ? defaultModel : names[0],
      });
      if (ui.isCancel(picked)) process.exit(0);
      model = /** @type {string} */ (picked);
    } else {
      const typed = await ui.text({
        message: "Retain / consolidate model",
        placeholder: defaultModel,
        defaultValue: defaultModel,
      });
      if (ui.isCancel(typed)) process.exit(0);
      model = /** @type {string} */ (typed);
    }
    apiBase = ollamaInCompose ? OLLAMA_COMPOSE_API_BASE : OLLAMA_HOST_API_BASE;
    if (ollamaInCompose) handoff.MEMORY_OLLAMA_IN_COMPOSE = "1";
  } else if (backend === "meridian") {
    const m = await askMeridian(ctx, ui, h);
    model = m.model;
    reflectModel = m.reflectModel;
    apiBase = m.apiBase;
    Object.assign(handoff, m.env);
  } else {
    const defaultBase = "http://host.docker.internal:3456/v1";
    const defaultModel =
      h.envValue(wizardConf, "MEMORY_MODEL") ||
      LEMOND_DEFAULT_MODEL;
    const baseInput = await ui.text({
      message: "OpenAI-compatible base URL (host.docker.internal from containers)",
      placeholder: defaultBase,
      defaultValue: defaultBase,
    });
    if (ui.isCancel(baseInput)) process.exit(0);
    apiBase = normalizeOpenAiBase(/** @type {string} */ (baseInput));

    const spin = ui.spinner();
    spin.start("Listing models");
    const body = await fetchJson(`${apiBase}/models`);
    const ids = openAiModelIds(body);
    spin.stop(
      ids.length
        ? `Found ${ids.length} models`
        : "Could not list models (enter id manually)",
    );

    if (ids.length > 0) {
      const picked = await ui.select({
        message: "Retain / consolidate model",
        options: ids.map((id) => ({ value: id, label: id })),
        initialValue: ids.includes(defaultModel) ? defaultModel : ids[0],
      });
      if (ui.isCancel(picked)) process.exit(0);
      model = /** @type {string} */ (picked);
    } else {
      const typed = await ui.text({
        message: "Retain / consolidate model id",
        placeholder: defaultModel,
        defaultValue: defaultModel,
      });
      if (ui.isCancel(typed)) process.exit(0);
      model = /** @type {string} */ (typed);
    }
  }

  if (backend !== "meridian") reflectModel = await askReflect(ui, model, reflectModel);

  ui.note("Next: Docker, secrets, indexing, and starting the stack.", "Backend configured");

  handoff.WIZARD_SKIP_BACKEND_STEP = "1";
  handoff.PM_BACKEND = /** @type {string} */ (backend);
  handoff.PM_DEFAULT_MODEL = model;
  handoff.MEMORY_API_BASE = apiBase;
  handoff.PM_REFLECT_MODEL = reflectModel;
  return handoff;
}

/**
 * @param {typeof import("@clack/prompts")} ui
 * @param {string} model retain model
 * @param {string} reflectModel stored or env reflect model
 */
async function askReflect(ui, model, reflectModel) {
  const reflectChoice = await ui.select({
    message: "Reflect model (needs tool calls; used for memory-reflect)",
    options: [
      {
        value: "",
        label: "Shipped default for this backend",
        hint: "E4B route on lemond, etc.",
      },
      { value: "same", label: "Same as retain model" },
      { value: "custom", label: "Pick another model id" },
    ],
    initialValue: reflectModel ? "custom" : "",
  });
  if (ui.isCancel(reflectChoice)) process.exit(0);

  if (reflectChoice === "same") {
    reflectModel = model;
  } else if (reflectChoice === "custom") {
    const typed = await ui.text({
      message: "Reflect model id",
      placeholder: model,
      defaultValue: reflectModel || model,
    });
    if (ui.isCancel(typed)) process.exit(0);
    reflectModel = /** @type {string} */ (typed);
  } else {
    reflectModel = "";
  }
  return reflectModel;
}

/**
 * Meridian URL, key and models. Detect only: Meridian must already run.
 * @param {{ home: string, wizardConf: string }} ctx
 * @param {typeof import("@clack/prompts")} ui
 * @param {Helpers} h
 */
async function askMeridian(ctx, ui, h) {
  ui.log.info(`The wizard does not install or start Meridian; see ${MERIDIAN_GUIDE}.`);
  const stored =
    h.envValue(ctx.wizardConf, "MEMORY_BACKEND") === "meridian"
      ? h.envValue(ctx.wizardConf, "MEMORY_MERIDIAN_URL")
      : "";
  const defaultBase = process.env.MERIDIAN_BASE || stored || MERIDIAN_DEFAULT_BASE;
  const baseInput = await ui.text({
    message: "Meridian URL from this host",
    placeholder: defaultBase,
    defaultValue: defaultBase,
  });
  if (ui.isCancel(baseInput)) process.exit(0);
  const meridianBase = normalizeMeridianBase(/** @type {string} */ (baseInput));
  const paths = {
    meridianEnvFile: `${ctx.home}/.config/meridian/meridian.env`,
    litellmEnv: `${ctx.home}/.config/hindsight/litellm.env`,
  };
  const existing = existingMeridianKey(paths, h);
  const keyInput = await ui.password({
    message: `MERIDIAN_API_KEY (blank uses ${existing.source || "no key"})`,
  });
  if (ui.isCancel(keyInput)) process.exit(0);
  const typedKey = String(keyInput || "").trim();
  const key = typedKey || existing.key;

  const bridgeIp = dockerBridgeIp();
  const spin = ui.spinner();
  spin.start(`Checking Meridian at ${meridianBase}`);
  const probe = await probeMeridian(meridianBase, key, bridgeIp);
  spin.stop(
    probe.answered ? `Meridian answered (${probe.ids.length} models)` : "Meridian not reachable",
  );
  if (!probe.answered) {
    ui.log.warn(`Start Meridian first (${MERIDIAN_GUIDE}); the route uses the guide's default models.`);
  } else if (probe.modelsStatus === 401 || probe.modelsStatus === 403) {
    ui.log.warn(`Meridian rejected the key on /v1/models (HTTP ${probe.modelsStatus}).`);
  }
  const apiBase = containerApiBase(meridianBase);
  const report = bridgeReport({ ...paths, meridianBase, apiBase, dockerBridgeIp: bridgeIp }, h.envValue, probe);
  if (report) (report.level === "warn" ? ui.log.warn : ui.log.info)(report.text);

  const choose = async (message, preferred, family, candidates) => {
    const def = pickModel(probe.ids, preferred, family, candidates);
    const picked = probe.ids.length
      ? await ui.select({
          message,
          options: probe.ids.map((id) => ({ value: id, label: id })),
          initialValue: def,
        })
      : await ui.text({ message, placeholder: def, defaultValue: def });
    if (ui.isCancel(picked)) process.exit(0);
    return /** @type {string} */ (picked);
  };
  const sameBackend = h.envValue(ctx.wizardConf, "MEMORY_BACKEND") === "meridian";
  const model = await choose("Retain / consolidate model", MERIDIAN_RETAIN_DEFAULT, /haiku/, [
    process.env.PM_DEFAULT_MODEL,
    sameBackend ? h.envValue(ctx.wizardConf, "MEMORY_MODEL") : "",
  ]);
  const reflectModel = await choose("Reflect model (needs tool calls)", MERIDIAN_REFLECT_DEFAULT, /sonnet/, [
    process.env.PM_REFLECT_MODEL,
    sameBackend ? h.envValue(ctx.wizardConf, "MEMORY_REFLECT_MODEL") : "",
  ]);
  /** @type {Record<string, string>} */
  const env = { MERIDIAN_BASE: meridianBase };
  if (typedKey) env.MERIDIAN_API_KEY = typedKey;
  return { model, reflectModel, apiBase, env };
}
