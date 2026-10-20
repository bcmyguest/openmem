/**
 * Hindsight's questions for the Clack setup UI: model backend, models, reflect model.
 * The meta UI asks the provider-neutral questions (action, provider) and then calls
 * clackSetup; the returned environment is handed to the wizard so it skips its own
 * model prompts (WIZARD_SKIP_BACKEND_STEP).
 */
import { applyConfigEnv } from "./config.mjs";
import { fetchJson, normalizeOpenAiBase, ollamaModelNames, openAiModelIds } from "./probe.mjs";
import { LEMOND_DEFAULT_MODEL, OLLAMA_DEFAULT_MODEL } from "./state.mjs";

/** @typedef {import("../../../wizard/lib/provider-wizard/helpers.mjs").ProviderWizardHelpers} Helpers */

/**
 * @param {{ repoRoot: string, home: string, wizardConf: string, pmMerged?: Record<string, unknown> }} ctx
 * @param {typeof import("@clack/prompts")} ui the @clack/prompts module
 * @param {Helpers} h
 * @returns {Promise<Record<string, string>>} environment for the wizard process
 */
export async function clackSetup(ctx, ui, h) {
  const machine = h.loadMachineEnv(ctx.repoRoot);
  const wizardConf = ctx.wizardConf;
  if (ctx.pmMerged) applyConfigEnv(ctx.pmMerged);
  /** @type {Record<string, string>} */
  const handoff = {};

  const lemondBase = machine.LEMOND_BASE || "http://127.0.0.1:13305";
  handoff.LEMOND_BASE = lemondBase;

  const backendDefault =
    process.env.PM_BACKEND ||
    machine.PM_BACKEND ||
    machine.MEMORY_BACKEND ||
    (h.envValue(wizardConf, "MEMORY_BACKEND")) ||
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
        hint: "Meridian, hosted API, other",
      },
    ],
    initialValue: ["lemond", "ollama", "custom"].includes(backendDefault)
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
    machine.PM_REFLECT_MODEL ||
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
      machine.PM_DEFAULT_MODEL ||
      machine.MEMORY_MODEL ||
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
    const ollamaBase = machine.OLLAMA_BASE || "http://127.0.0.1:11434";
    const spin = ui.spinner();
    spin.start(`Checking Ollama at ${ollamaBase}`);
    const body = await fetchJson(`${ollamaBase}/api/tags`);
    const names = ollamaModelNames(body);
    spin.stop(
      body ? `Ollama answered (${names.length} models)` : "Ollama not reachable",
    );
    const defaultModel =
      machine.PM_DEFAULT_MODEL ||
      machine.MEMORY_MODEL ||
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
    apiBase = "http://host.docker.internal:11434";
  } else {
    const defaultBase =
      machine.CUSTOM_DEFAULT_BASE || "http://host.docker.internal:3456/v1";
    const defaultModel =
      machine.CUSTOM_DEFAULT_MODEL ||
      machine.PM_DEFAULT_MODEL ||
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

  ui.note("Next: Docker, secrets, indexing, and starting the stack.", "Backend configured");

  handoff.WIZARD_SKIP_BACKEND_STEP = "1";
  handoff.PM_BACKEND = /** @type {string} */ (backend);
  handoff.PM_DEFAULT_MODEL = model;
  handoff.MEMORY_API_BASE = apiBase;
  handoff.PM_REFLECT_MODEL = reflectModel;
  return handoff;
}
