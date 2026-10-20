/**
 * Cognee's question for the Clack setup UI: the LLM API key, entered through a hidden
 * (password) prompt. The answer travels to the wizard only as PM_COGNEE_LLM_API_KEY in the
 * wizard process's own environment (never on a command line, never written anywhere but
 * cognee.env), and `configureModelRouting` removes it from the environment once read.
 * Other LLM and embedding settings come from PM_COGNEE_<NAME> variables (see llm-env.mjs).
 */
import { KEY_NAME } from "./llm-env.mjs";
import { readEnvFile } from "./env-file.mjs";
import { applyConfig } from "./config.mjs";

/** @typedef {import("../../../wizard/lib/provider-wizard/helpers.mjs").ProviderWizardHelpers} Helpers */

/**
 * @param {{ repoRoot: string, home: string, pmMerged?: Record<string, unknown> }} ctx
 * @param {typeof import("@clack/prompts")} ui the @clack/prompts module
 * @param {Helpers} h
 * @returns {Promise<Record<string, string>>} environment for the wizard process
 */
export async function clackSetup(ctx, ui, h) {
  const state = /** @type {Record<string, any>} */ (ctx);
  state.pmMerged ||= {};
  applyConfig(state, h);
  /** @type {Record<string, string>} */
  const handoff = { WIZARD_SKIP_BACKEND_STEP: "1" };
  if (typeof ui.password !== "function") return handoff;

  const stored = readEnvFile(state.cognee.envFile).values.get(KEY_NAME);
  if (stored) {
    const replace = await ui.confirm({
      message: `${state.cognee.envFile} already has an LLM_API_KEY. Replace it?`,
      initialValue: false,
    });
    if (ui.isCancel(replace)) {
      ui.cancel("Setup cancelled.");
      process.exit(0);
    }
    if (!replace) return handoff;
  }
  ui.log.info("Cognee builds its graph with an LLM; the key is stored in cognee.env (mode 600), never in the repo.");
  const key = await ui.password({
    message: "Cognee LLM_API_KEY (input hidden; press Enter to skip)",
  });
  if (ui.isCancel(key)) {
    ui.cancel("Setup cancelled.");
    process.exit(0);
  }
  if (String(key ?? "").trim()) handoff.PM_COGNEE_LLM_API_KEY = String(key).trim();
  return handoff;
}
