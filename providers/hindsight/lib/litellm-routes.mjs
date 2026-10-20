import fs from "node:fs";
import path from "node:path";
import { configToml } from "./config.mjs";
import { OLLAMA_HOST_API_BASE } from "./state.mjs";

/** @typedef {import("../../../wizard/lib/provider-wizard/helpers.mjs").ProviderWizardHelpers} Helpers */

/** Shipped litellm.<backend>.yaml api_base for the host-side model server. */
function shippedApiBase(backend) {
  if (backend === "ollama") return OLLAMA_HOST_API_BASE;
  if (backend === "lemond") return "http://host.docker.internal:13305/v1";
  return "";
}

/**
 * @param {Record<string, any>} ctx
 * @param {string} alias
 * @param {string} litellmModel
 */
function renderRoute(ctx, alias, litellmModel) {
  let out = `  - model_name: ${alias}\n    litellm_params:\n      model: ${litellmModel}\n      api_base: ${ctx.apiBase}\n`;
  if (ctx.backend === "ollama") {
    out += "      extra_body:\n        think: false\n";
  } else {
    out += "      api_key: os.environ/LEMOND_API_KEY\n      extra_body:\n        chat_template_kwargs:\n          enable_thinking: false\n";
  }
  return out;
}

/**
 * @param {Record<string, any>} ctx
 * @param {string} litellmModel
 */
function renderOverride(ctx, litellmModel) {
  return (
    "# Written by ./setup. Replaces config/litellm.*.yaml while this file exists.\n" +
    "# Delete it, or rerun ./setup with the shipped model, to use the shipped routes again.\n" +
    "# Thinking is off for all three aliases. Non-ollama servers get chat_template_kwargs; a server that rejects it needs a different route.\n" +
    "model_list:\n" +
    renderRoute(ctx, "memory-retain", litellmModel) +
    renderRoute(ctx, "memory-reflect", litellmModel) +
    renderRoute(ctx, "memory-consolidate", litellmModel) +
    "general_settings:\n  master_key: os.environ/LITELLM_MASTER_KEY\n"
  );
}

/**
 * @param {Record<string, any>} ctx
 * @param {string} litellmModel
 * @param {string} reflectLitellmModel
 */
function renderShipped(ctx, litellmModel, reflectLitellmModel) {
  const src = path.join(ctx.repoRoot, "config", `litellm.${ctx.backend}.yaml`);
  const lines = fs.readFileSync(src, "utf8").split("\n");
  const out = [
    `# Written by ./setup from config/litellm.${ctx.backend}.yaml. Replaces the shipped routes while this file exists.`,
    "# Delete it, or rerun ./setup with the shipped models, to use the shipped routes again.",
  ];
  let name = "";
  for (const line of lines) {
    const mn = line.match(/^  - model_name: (\S+)/);
    if (mn) name = mn[1];
    if (/^      api_base: /.test(line)) {
      out.push(`      api_base: ${ctx.apiBase}`);
      continue;
    }
    if (/^      model: /.test(line)) {
      if (name !== "memory-reflect") out.push(`      model: ${litellmModel}`);
      else if (reflectLitellmModel) out.push(`      model: ${reflectLitellmModel}`);
      else out.push(line);
      continue;
    }
    out.push(line);
  }
  return `${out.join("\n")}\n`;
}

/**
 * @param {Record<string, any>} ctx
 * @returns {string}
 */
export function litellmConfig(ctx) {
  let prefix = "openai/";
  if (ctx.backend === "ollama") prefix = "ollama_chat/";
  if (ctx.backend === "custom") return renderOverride(ctx, `${prefix}${ctx.model}`);
  let reflect = "";
  if (ctx.reflectModel) reflect = `${prefix}${ctx.reflectModel}`;
  return renderShipped(ctx, `${prefix}${ctx.model}`, reflect);
}

/**
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export async function removeOverrideIfAsked(ctx, h) {
  if (!fs.existsSync(ctx.litellmOverride)) return;
  if (ctx.dry) {
    h.info(`[dry-run] move ${ctx.litellmOverride} aside so the shipped ${ctx.backend} routes apply`);
    return;
  }
  if (!(await h.confirm(ctx, `Move ${ctx.litellmOverride} aside so the shipped ${ctx.backend} routes apply?`, "y"))) {
    h.warn("kept the override; it still takes precedence over the shipped routes");
    return;
  }
  const bak = `${ctx.litellmOverride}.bak-${timestamp()}`;
  fs.renameSync(ctx.litellmOverride, bak);
  h.ok("moved the override aside");
}

/**
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export async function writeOverride(ctx, h) {
  if (ctx.dry) {
    h.info(
      `[dry-run] write ${ctx.litellmOverride} from config/litellm.${ctx.backend}.yaml: retain and consolidate -> ${ctx.model}, reflect -> ${ctx.reflectModel || "shipped"}, at ${ctx.apiBase}`,
    );
    return;
  }
  h.ensureConfigDir(ctx);
  const content = litellmConfig(ctx);
  const tmp = path.join(ctx.hsDir, `.litellm.yaml.${process.pid}`);
  fs.writeFileSync(tmp, content, { mode: 0o644 });
  if (fs.existsSync(ctx.litellmOverride)) {
    const existing = fs.readFileSync(ctx.litellmOverride);
    if (Buffer.compare(existing, Buffer.from(content)) === 0) {
      fs.unlinkSync(tmp);
      h.ok(`${ctx.litellmOverride} already has this route`);
      return;
    }
    if (!(await h.confirm(ctx, `Replace ${ctx.litellmOverride} (the old file is kept as .bak)?`, "y"))) {
      fs.unlinkSync(tmp);
      h.warn("kept the existing override; it still takes precedence");
      return;
    }
    fs.copyFileSync(ctx.litellmOverride, `${ctx.litellmOverride}.bak-${timestamp()}`);
  }
  fs.renameSync(tmp, ctx.litellmOverride);
  h.ok(`wrote ${ctx.litellmOverride}`);
}

/**
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export async function applyRoute(ctx, h) {
  let shipped = "";
  if (ctx.backend === "lemond") shipped = ctx.lemondDefaultModel;
  if (ctx.backend === "ollama") shipped = ctx.ollamaDefaultModel;
  const defaultBase = shippedApiBase(ctx.backend);
  const apiMatchesShipped = !ctx.apiBase || ctx.apiBase === defaultBase;
  if (ctx.backend !== "custom" && ctx.model === shipped && !ctx.reflectModel && apiMatchesShipped) {
    await removeOverrideIfAsked(ctx, h);
  } else {
    await writeOverride(ctx, h);
  }
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Record the backend choice in wizard.conf (and config.toml).
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export function saveConf(ctx, h) {
  if (ctx.dry) {
    h.info(`[dry-run] record backend ${ctx.backend} in ${ctx.wizardConf}`);
    return;
  }
  h.saveWizardConf(
    ctx,
    {
      MEMORY_BACKEND: ctx.backend,
      MEMORY_MODEL: ctx.model,
      MEMORY_API_BASE: ctx.apiBase,
      MEMORY_REFLECT_MODEL: ctx.reflectModel,
      MEMORY_OLLAMA_IN_COMPOSE: ctx.ollamaInCompose ? "1" : "0",
    },
    { pmSections: configToml(ctx) },
  );
}
