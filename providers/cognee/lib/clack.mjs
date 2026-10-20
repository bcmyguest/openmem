/**
 * Cognee's Clack setup UI: choose OpenAI-compatible key vs local Ollama, then (for OpenAI)
 * a hidden password prompt. Answers travel to the wizard only as PM_COGNEE_* in the wizard
 * process's own environment (never on a command line, never written anywhere but cognee.env).
 * `configureModelRouting` removes secrets from the environment once read.
 */
import net from "node:net";
import { KEY_NAME, OLLAMA_API_KEY, ollamaDefaultsForEnv } from "./llm-env.mjs";
import { readEnvFile } from "./env-file.mjs";
import { applyConfig } from "./config.mjs";
import fs from "node:fs";
import path from "node:path";

/** @typedef {import("../../../wizard/lib/provider-wizard/helpers.mjs").ProviderWizardHelpers} Helpers */

/**
 * Best-effort TCP probe of host Ollama (127.0.0.1:11434). Never throws.
 * @returns {Promise<boolean>}
 */
function probeHostOllama() {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: 11434 });
    const done = (/** @type {boolean} */ ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

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

  const stored = readEnvFile(state.cognee.envFile).values.get(KEY_NAME);
  if (stored) {
    if (typeof ui.confirm !== "function") return handoff;
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

  let choice = "openai";
  if (typeof ui.select === "function") {
    const picked = await ui.select({
      message: "How will Cognee talk to an LLM for cognify?",
      options: [
        {
          value: "openai",
          label: "OpenAI-compatible API key",
          hint: "stored in cognee.env (mode 600)",
        },
        {
          value: "ollama",
          label: "Ollama on this host",
          hint: "no cloud key; host Ollama via host.docker.internal, or compose via PM_COGNEE_OLLAMA_COMPOSE=1",
        },
      ],
      initialValue: "openai",
    });
    if (ui.isCancel(picked)) {
      ui.cancel("Setup cancelled.");
      process.exit(0);
    }
    choice = String(picked);
  }

  if (choice === "ollama") {
    const up = await probeHostOllama();
    if (up) ui.log?.info?.("Ollama answered on 127.0.0.1:11434");
    else ui.log?.warn?.("Ollama is not answering on 127.0.0.1:11434; start it before cognify, or point LLM_ENDPOINT elsewhere in cognee.env");
    // Prefer compose service DNS when this machine already uses compose Ollama (loopback-only).
    const confPath = path.join(ctx.home || "", ".config/hindsight/wizard.conf");
    let composeOllama = process.env.PM_COGNEE_OLLAMA_COMPOSE === "1" || process.env.MEMORY_OLLAMA_IN_COMPOSE === "1";
    if (!composeOllama && fs.existsSync(confPath)) {
      composeOllama = /^MEMORY_OLLAMA_IN_COMPOSE=1\s*$/m.test(fs.readFileSync(confPath, "utf8"));
    }
    const defaults = ollamaDefaultsForEnv(
      composeOllama ? { ...process.env, PM_COGNEE_OLLAMA_COMPOSE: "1" } : process.env,
    );
    if (composeOllama) {
      ui.log?.info?.(
        "Compose Ollama detected: writing http://ollama:11434 (attach Cognee to the same Docker network).",
      );
      handoff.PM_COGNEE_OLLAMA_COMPOSE = "1";
    }
    handoff.PM_COGNEE_LLM_PROVIDER = "ollama";
    handoff.PM_COGNEE_LLM_API_KEY = OLLAMA_API_KEY;
    handoff.PM_COGNEE_LLM_ENDPOINT = defaults.LLM_ENDPOINT;
    handoff.PM_COGNEE_EMBEDDING_PROVIDER = defaults.EMBEDDING_PROVIDER;
    handoff.PM_COGNEE_EMBEDDING_MODEL = defaults.EMBEDDING_MODEL;
    handoff.PM_COGNEE_EMBEDDING_ENDPOINT = defaults.EMBEDDING_ENDPOINT;
    handoff.PM_COGNEE_EMBEDDING_DIMENSIONS = defaults.EMBEDDING_DIMENSIONS;
    return handoff;
  }

  if (typeof ui.password !== "function") return handoff;
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
