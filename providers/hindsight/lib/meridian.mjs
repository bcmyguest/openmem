/**
 * Detect-only "Claude subscription (Meridian)" backend: probe a Meridian proxy the user
 * already runs, write the LiteLLM route from docs/meridian-litellm.md, and keep
 * MERIDIAN_API_KEY in litellm.env. The wizard never installs or starts Meridian.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetchStatus, openAiModelIds } from "./probe.mjs";
import { ensureLitellmEnv } from "./stack-env.mjs";
import { storedOr } from "./state.mjs";

/** @typedef {import("../../../wizard/lib/provider-wizard/helpers.mjs").ProviderWizardHelpers} Helpers */

export const MERIDIAN_DEFAULT_PORT = "3456";
export const MERIDIAN_DEFAULT_BASE = `http://127.0.0.1:${MERIDIAN_DEFAULT_PORT}`;
/** Guide defaults (docs/meridian-litellm.md#route-file). */
export const MERIDIAN_RETAIN_DEFAULT = "claude-haiku-5-5";
export const MERIDIAN_REFLECT_DEFAULT = "claude-sonnet-5-5";
export const MERIDIAN_TERMS_URL = "https://www.anthropic.com/legal/consumer-terms";
export const MERIDIAN_GUIDE = "docs/meridian-litellm.md";
/** litellm.env value when Meridian runs without a key; LiteLLM still needs a non-empty one. */
export const MERIDIAN_NO_KEY = "placeholder";

const BRIDGE_TIMEOUT_MS = 2000;
const PROBE_TIMEOUT_MS = 5000;

/** IPv4 address of the default Docker bridge (docker0), which `host-gateway` resolves to. */
export function dockerBridgeIp() {
  const nics = os.networkInterfaces().docker0 || [];
  const v4 = nics.find((n) => n.family === "IPv4" || n.family === 4);
  return v4 ? v4.address : "";
}

/** @param {string} base */
export function normalizeMeridianBase(base) {
  return base.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** @param {string} hostname */
function isLoopback(hostname) {
  return hostname === "localhost" || hostname === "[::1]" || hostname.startsWith("127.");
}

/** @param {URL} u */
function portOf(u) {
  return u.port || (u.protocol === "https:" ? "443" : "80");
}

/**
 * The api_base the LiteLLM container uses: host.docker.internal for a loopback URL,
 * otherwise the URL itself. No /v1: LiteLLM appends /v1/messages.
 * @param {string} hostBase
 */
export function containerApiBase(hostBase) {
  const u = new URL(hostBase);
  if (!isLoopback(u.hostname)) return `${u.protocol}//${u.host}`;
  return `http://host.docker.internal:${portOf(u)}`;
}

/**
 * First usable model: a valid candidate, else `preferred` when listed, else the first id
 * matching `family`, else the first id, else `preferred`.
 * @param {string[]} ids ids from Meridian's /v1/models (may be empty)
 * @param {string} preferred
 * @param {RegExp} family
 * @param {string[]} candidates explicit or stored choices, in priority order
 */
export function pickModel(ids, preferred, family, candidates = []) {
  const valid = (m) => Boolean(m) && (ids.length ? ids.includes(m) : m.startsWith("claude-"));
  const hit = candidates.find(valid);
  if (hit) return hit;
  if (!ids.length || ids.includes(preferred)) return preferred;
  return ids.find((id) => family.test(id)) || ids[0];
}

/**
 * Where an existing Meridian key comes from: the environment, Meridian's own env file
 * (the guide's ~/.config/meridian/meridian.env), or litellm.env.
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 * @returns {{ key: string, source: string }}
 */
export function existingMeridianKey(ctx, h) {
  if (process.env.MERIDIAN_API_KEY) {
    return { key: process.env.MERIDIAN_API_KEY, source: "MERIDIAN_API_KEY from the environment" };
  }
  const fromMeridian = h.envValue(ctx.meridianEnvFile, "MERIDIAN_API_KEY");
  if (fromMeridian) return { key: fromMeridian, source: ctx.meridianEnvFile };
  const fromLitellm = h.envValue(ctx.litellmEnv, "MERIDIAN_API_KEY");
  if (fromLitellm && fromLitellm !== MERIDIAN_NO_KEY) return { key: fromLitellm, source: ctx.litellmEnv };
  return { key: "", source: "" };
}

/**
 * Probe Meridian from the host: /health (open), /v1/models (needs the key when set), and
 * /health on the Docker bridge address to tell a loopback-only bind from 0.0.0.0.
 * @param {string} base host URL without /v1
 * @param {string} key MERIDIAN_API_KEY or ""
 * @param {string} bridgeIp docker0 IPv4, or "" when unknown
 */
export async function probeMeridian(base, key, bridgeIp) {
  const headers = key ? { "x-api-key": key } : {};
  const health = await fetchStatus(`${base}/health`, { timeoutMs: PROBE_TIMEOUT_MS });
  const models = await fetchStatus(`${base}/v1/models`, { headers, timeoutMs: PROBE_TIMEOUT_MS });
  const u = new URL(base);
  /** @type {"ok"|"unreachable"|"unknown"|"n/a"} */
  let bridge = "n/a";
  const answered = health.status > 0 || models.status > 0;
  if (answered && isLoopback(u.hostname)) {
    if (!bridgeIp) bridge = "unknown";
    else {
      const viaBridge = await fetchStatus(`http://${bridgeIp}:${portOf(u)}/health`, {
        timeoutMs: BRIDGE_TIMEOUT_MS,
      });
      bridge = viaBridge.status > 0 ? "ok" : "unreachable";
    }
  }
  return {
    answered,
    healthOk: health.status >= 200 && health.status < 300,
    modelsStatus: models.status,
    ids: models.status === 200 ? openAiModelIds(models.json) : [],
    bridge,
  };
}

/** @param {string[]} names @param {Helpers} h */
function showModels(names, h) {
  for (const n of names) h.info(`      ${n}`);
}

/**
 * What the probe says about reachability from the LiteLLM container.
 * @param {{ meridianBase: string, apiBase: string, dockerBridgeIp: string, meridianEnvFile: string }} ctx
 * @param {(file: string, key: string) => string} envValue
 * @param {Awaited<ReturnType<typeof probeMeridian>>} probe
 * @returns {{ level: "ok"|"warn"|"info", text: string } | null}
 */
export function bridgeReport(ctx, envValue, probe) {
  const u = new URL(ctx.meridianBase);
  const port = portOf(u);
  const bindHint = `Restart Meridian with MERIDIAN_HOST=0.0.0.0 (${MERIDIAN_GUIDE}#run-meridian).`;
  const declaredHost = process.env.MERIDIAN_HOST || envValue(ctx.meridianEnvFile, "MERIDIAN_HOST");
  if (probe.bridge === "ok") {
    return {
      level: "ok",
      text: `Meridian also answers on the Docker bridge address ${ctx.dockerBridgeIp}:${port}; LiteLLM calls ${ctx.apiBase}. A firewall can still block containers; run the guide's smoke test.`,
    };
  }
  if (probe.bridge === "unreachable") {
    return {
      level: "warn",
      text: `Meridian answers on ${u.host} but not on the Docker bridge address ${ctx.dockerBridgeIp}:${port}: it binds 127.0.0.1 only, so the LiteLLM container cannot reach ${ctx.apiBase}. ${bindHint}`,
    };
  }
  if (declaredHost && isLoopback(declaredHost)) {
    return {
      level: "warn",
      text: `MERIDIAN_HOST is ${declaredHost}: the LiteLLM container cannot reach a loopback-only Meridian. ${bindHint}`,
    };
  }
  if (isLoopback(u.hostname)) {
    return {
      level: "info",
      text: `LiteLLM calls Meridian at ${ctx.apiBase}. On Linux, a Meridian bound to 127.0.0.1 (its default) is unreachable from the container; run it with MERIDIAN_HOST=0.0.0.0.`,
    };
  }
  return null;
}

/**
 * Interactive and --yes Meridian questions. Fills ctx.meridianBase, ctx.meridianKey,
 * ctx.apiBase, ctx.model and ctx.reflectModel.
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export async function chooseMeridian(ctx, h) {
  h.info(`The wizard does not install or start Meridian; see ${MERIDIAN_GUIDE}.`);
  if (ctx.dockerBridgeIp === undefined) ctx.dockerBridgeIp = dockerBridgeIp();
  const port = h.envValue(ctx.meridianEnvFile, "MERIDIAN_PORT") || MERIDIAN_DEFAULT_PORT;
  const defaultBase =
    process.env.MERIDIAN_BASE ||
    storedOr(ctx, h, "meridian", "MEMORY_MERIDIAN_URL", `http://127.0.0.1:${port}`);
  ctx.meridianBase = normalizeMeridianBase(await h.ask(ctx, "Meridian URL from this host", defaultBase));
  try {
    ctx.apiBase = containerApiBase(ctx.meridianBase);
  } catch {
    h.die(`not a URL: ${ctx.meridianBase}`);
  }

  const existing = existingMeridianKey(ctx, h);
  const typed = await h.ask(
    ctx,
    `MERIDIAN_API_KEY (typed input is visible; blank uses ${existing.source || "no key"})`,
    "",
  );
  ctx.meridianKey = typed || existing.key;

  const probe = await probeMeridian(ctx.meridianBase, ctx.meridianKey, ctx.dockerBridgeIp);
  if (!probe.answered) {
    h.warn(
      `Meridian is not answering on ${ctx.meridianBase}. Start it first (npm install -g @rynfar/meridian; claude login; meridian), see ${MERIDIAN_GUIDE}. The route uses the guide's default models.`,
    );
  } else {
    h.ok(`Meridian answers on ${ctx.meridianBase}${probe.healthOk ? "" : " (/health not OK)"}`);
    if (probe.modelsStatus === 401 || probe.modelsStatus === 403) {
      h.warn(
        `Meridian rejected ${ctx.meridianKey ? "the key" : "a request without a key"} on /v1/models (HTTP ${probe.modelsStatus}): set MERIDIAN_API_KEY to the key Meridian runs with.`,
      );
    } else if (probe.ids.length) {
      h.ok(`Meridian lists ${probe.ids.length} models`);
      showModels(probe.ids, h);
    } else h.warn(`Meridian returned no model list (HTTP ${probe.modelsStatus}); using the guide's defaults`);
  }
  const bridge = bridgeReport(ctx, h.envValue, probe);
  if (bridge) h[bridge.level](bridge.text);
  if (!ctx.meridianKey) {
    h.warn("No MERIDIAN_API_KEY: with MERIDIAN_HOST=0.0.0.0 anyone on the network can use your subscription.");
  }

  const retainDefault = pickModel(probe.ids, MERIDIAN_RETAIN_DEFAULT, /haiku/, [
    process.env.PM_DEFAULT_MODEL,
    storedOr(ctx, h, "meridian", "MEMORY_MODEL", ""),
  ]);
  const reflectDefault = pickModel(probe.ids, MERIDIAN_REFLECT_DEFAULT, /sonnet/, [
    process.env.PM_REFLECT_MODEL,
    storedOr(ctx, h, "meridian", "MEMORY_REFLECT_MODEL", ""),
  ]);
  ctx.model = await h.ask(ctx, "Meridian retain / consolidate model", retainDefault);
  ctx.reflectModel = await h.ask(ctx, "Meridian reflect model (needs tool calls)", reflectDefault);
  for (const m of [ctx.model, ctx.reflectModel]) {
    if (probe.ids.length && !probe.ids.includes(m)) h.warn(`${m} is not listed by Meridian's /v1/models`);
  }
}

/**
 * One alias of the guide's route file.
 * @param {string} alias
 * @param {string} model
 * @param {string} apiBase
 */
function renderAlias(alias, model, apiBase) {
  return (
    `  - model_name: ${alias}\n` +
    "    litellm_params:\n" +
    `      model: anthropic/${model}\n` +
    `      api_base: ${apiBase}\n` +
    "      api_key: os.environ/MERIDIAN_API_KEY\n" +
    "      max_tokens: 4096\n" +
    "      timeout: 300\n" +
    '      additional_drop_params: ["reasoning_effort"]\n'
  );
}

/**
 * The route file from docs/meridian-litellm.md#route-file. The key stays in litellm.env.
 * @param {Record<string, any>} ctx
 */
export function renderMeridianRoutes(ctx) {
  const reflect = ctx.reflectModel || ctx.model;
  return (
    "# Written by ./setup: LiteLLM routes for Hindsight, backend Meridian on the host (Claude subscription).\n" +
    `# See ${MERIDIAN_GUIDE}. MERIDIAN_API_KEY lives in ~/.config/hindsight/litellm.env.\n` +
    "# No thinking parameter: Meridian rejects thinking: disabled on Haiku 5.5, so reasoning_effort is dropped.\n" +
    "model_list:\n" +
    renderAlias("memory-retain", ctx.model, ctx.apiBase) +
    renderAlias("memory-reflect", reflect, ctx.apiBase) +
    renderAlias("memory-consolidate", ctx.model, ctx.apiBase) +
    "\ngeneral_settings:\n  master_key: os.environ/LITELLM_MASTER_KEY\n"
  );
}

/**
 * Set MERIDIAN_API_KEY in litellm.env (mode 600), creating the file with a master key
 * when it does not exist yet. Never prints the value.
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export function writeMeridianKey(ctx, h) {
  const value = ctx.meridianKey || h.envValue(ctx.litellmEnv, "MERIDIAN_API_KEY") || MERIDIAN_NO_KEY;
  if (/[\r\n]/.test(value)) h.die("MERIDIAN_API_KEY must be one line");
  if (ctx.dry) {
    h.info(`[dry-run] set MERIDIAN_API_KEY in ${ctx.litellmEnv} (mode 600; value not printed)`);
    return;
  }
  h.ensureConfigDir(ctx);
  ensureLitellmEnv(ctx.litellmEnv);
  const lines = fs.readFileSync(ctx.litellmEnv, "utf8").replace(/\n$/, "").split("\n");
  const line = `MERIDIAN_API_KEY=${value}`;
  const at = lines.findIndex((l) => l.startsWith("MERIDIAN_API_KEY="));
  if (at >= 0 && lines[at] === line) {
    fs.chmodSync(ctx.litellmEnv, 0o600);
    h.ok(`${ctx.litellmEnv} already has MERIDIAN_API_KEY`);
    return;
  }
  if (at >= 0) lines[at] = line;
  else {
    if (value === MERIDIAN_NO_KEY) lines.push("# Meridian runs without MERIDIAN_API_KEY; LiteLLM needs a non-empty value.");
    lines.push(line);
  }
  const tmp = path.join(path.dirname(ctx.litellmEnv), `.litellm.env.${process.pid}`);
  fs.writeFileSync(tmp, `${lines.join("\n")}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, ctx.litellmEnv);
  h.ok(`set MERIDIAN_API_KEY in ${ctx.litellmEnv} (mode 600)`);
}
