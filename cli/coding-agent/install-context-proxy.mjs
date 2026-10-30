/**
 * Point Claude Code, OpenCode 1 and Codex at the local LiteLLM context proxy, or undo that.
 *
 * The proxy key travels as a request header. Claude Code reads ANTHROPIC_CUSTOM_HEADERS only
 * from its environment or a settings `env` block (no helper hook for headers), so a settings
 * file that holds the key is written mode 600; so are the OpenCode and Codex configs. Values that
 * were there before and are not ours are backed up (mode 600) and restored on disable.
 *
 * Codex keeps its ChatGPT login: a custom `[model_providers.openmem]` with `requires_openai_auth`
 * sends the ChatGPT bearer and ChatGPT-Account-ID as before, `http_headers` adds the LiteLLM key, and
 * `base_url` is LiteLLM's subscription pass-through `/backend-api/codex` (PR #41522). The built-in
 * openai provider cannot carry the extra header: Codex ignores `model_providers.openai` overrides.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import TOML from "@iarna/toml";
import { contextRoot } from "./context-store.mjs";
import { readJson, writeFileAtomic, writeJson } from "./file-io.mjs";
import { mergeOpencodeConfig, opencodeConfigPath, parseJsonc } from "./opencode-config.mjs";
import { removeSpans, tomlSpansUnder, tomlStatements } from "./toml-edit.mjs";

const KEY_NAME = "LITELLM_MASTER_KEY";
const HEADER_NAME = "x-litellm-api-key";
const LOOPBACK_URL = /^http:\/\/127\.0\.0\.1:\d+(?:\/v1)?$/;
const CODEX_LOOPBACK_URL = /^http:\/\/127\.0\.0\.1:\d+\/backend-api\/codex$/;
/** `model_provider` id the installer owns in ~/.codex/config.toml. */
export const CODEX_PROVIDER_ID = "openmem";
/** Agent ids installContextProxy wires (install-coding-agent ids; opencode is OpenCode 1 or 2). */
const PROXY_AGENT_IDS = ["claude-code", "opencode", "codex"];
const SECRET_MODE = 0o600;
const PROBE_TIMEOUT_MS = 1500;

export function contextProxyEnvPath(home) {
  return path.join(home, ".config", "personal-memory", "context-proxy.env");
}

/** Pre-proxy values of the settings the installer overwrites, restored on disable. */
export function contextProxyBackupPath(home) {
  return path.join(home, ".config", "personal-memory", "context-proxy-backup.json");
}

/** Return the master key from context-proxy.env, generating it (file mode 600) once. */
export function ensureContextProxyKey(home) {
  const file = contextProxyEnvPath(home);
  const previous = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const line = previous.split(/\r?\n/).find((l) => l.startsWith(`${KEY_NAME}=`));
  const existing = line?.slice(KEY_NAME.length + 1).trim();
  if (existing) {
    fs.chmodSync(file, SECRET_MODE);
    return existing;
  }
  const key = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const body = previous && !previous.endsWith("\n") ? `${previous}\n` : previous;
  writeFileAtomic(file, `${body}${KEY_NAME}=${key}\n`, { mode: SECRET_MODE });
  return key;
}

/** `docker compose` command that starts the proxy from the stack root. */
export function contextProxyStartCommand({ stackRoot, project = "openmem" } = {}) {
  const dir = stackRoot ? ` --project-directory ${JSON.stringify(stackRoot)}` : "";
  return `docker compose -p ${project}${dir} --profile hindsight --profile context-proxy up -d context-proxy`;
}

/** True when the proxy answers `/health/liveliness` on the loopback port within the timeout. */
export async function probeContextProxy(port, { fetch = globalThis.fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health/liveliness`, { signal: AbortSignal.timeout(timeoutMs) });
    return Boolean(res?.ok);
  } catch {
    return false;
  }
}

export function codexConfigPath(home) {
  return path.join(home, ".codex", "config.toml");
}

/** Parsed ~/.codex/config.toml (`{}` when missing); malformed TOML throws. */
function readCodexConfig(home) {
  const file = codexConfigPath(home);
  return fs.existsSync(file) ? TOML.parse(fs.readFileSync(file, "utf8")) : {};
}

/** True when the Codex config selects our provider or still has its loopback entry. */
function codexPointed(cfg) {
  const ours = cfg.model_providers?.[CODEX_PROVIDER_ID];
  return cfg.model_provider === CODEX_PROVIDER_ID || CODEX_LOOPBACK_URL.test(String(ours?.base_url || ""));
}

/**
 * Agents whose config still points at the loopback proxy: Claude Code (settings.json `env`),
 * OpenCode 1 (`provider.anthropic.options.baseURL`) and Codex (`model_provider = "openmem"`).
 * Stopping the proxy breaks them.
 * @returns {string[]}
 */
export function agentsPointedAtContextProxy(home) {
  const out = [];
  try {
    if (LOOPBACK_URL.test(String(readJson(path.join(home, ".claude", "settings.json")).env?.ANTHROPIC_BASE_URL || ""))) out.push("claude-code");
  } catch {
    // Unreadable settings: treat as not pointed.
  }
  try {
    const file = opencodeConfigPath(home);
    const options = fs.existsSync(file) ? parseJsonc(fs.readFileSync(file, "utf8"))?.provider?.anthropic?.options : undefined;
    if (LOOPBACK_URL.test(String(options?.baseURL || ""))) out.push("opencode");
  } catch {
    // Unreadable config: treat as not pointed.
  }
  try {
    if (codexPointed(readCodexConfig(home))) out.push("codex");
  } catch {
    // Unreadable config: treat as not pointed.
  }
  return out;
}

function readBackup(home) {
  try {
    return readJson(contextProxyBackupPath(home));
  } catch {
    return {};
  }
}

function writeBackup(home, backup) {
  const file = contextProxyBackupPath(home);
  if (!Object.keys(backup).length) fs.rmSync(file, { force: true });
  else writeJson(file, backup, { mode: SECRET_MODE });
}

const ourHeaderLine = (line) => line.trim().toLowerCase().startsWith(`${HEADER_NAME}:`);

/** ANTHROPIC_CUSTOM_HEADERS without any x-litellm-api-key line. */
function otherHeaderLines(value) {
  return String(value || "").split("\n").filter((l) => l.trim() && !ourHeaderLine(l));
}

function setOrDelete(obj, key, value) {
  if (value === undefined || value === "") delete obj[key];
  else obj[key] = value;
}

function wireClaude(home, { enabled, port, key }) {
  const file = path.join(home, ".claude", "settings.json");
  const settings = readJson(file);
  const env = { ...(settings.env || {}) };
  const backup = readBackup(home);
  const pointed = LOOPBACK_URL.test(String(env.ANTHROPIC_BASE_URL || ""));
  if (enabled) {
    // Already pointed at the proxy: what is there is ours, nothing to back up.
    const foreign = !pointed && (env.ANTHROPIC_BASE_URL !== undefined || env.ANTHROPIC_CUSTOM_HEADERS !== undefined);
    if (foreign && !backup.claudeCode) {
      backup.claudeCode = { ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL, ANTHROPIC_CUSTOM_HEADERS: env.ANTHROPIC_CUSTOM_HEADERS };
      writeBackup(home, backup);
    }
    env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
    env.ANTHROPIC_CUSTOM_HEADERS = [...otherHeaderLines(env.ANTHROPIC_CUSTOM_HEADERS), `${HEADER_NAME}: Bearer ${key}`].join("\n");
  } else {
    const hasOurHeader = String(env.ANTHROPIC_CUSTOM_HEADERS || "").split("\n")
      .some((l) => ourHeaderLine(l) && l.includes("Bearer "));
    if (!pointed || !hasOurHeader) return false;
    const saved = backup.claudeCode;
    if (saved) {
      setOrDelete(env, "ANTHROPIC_BASE_URL", saved.ANTHROPIC_BASE_URL);
      setOrDelete(env, "ANTHROPIC_CUSTOM_HEADERS", saved.ANTHROPIC_CUSTOM_HEADERS);
      delete backup.claudeCode;
      writeBackup(home, backup);
    } else {
      delete env.ANTHROPIC_BASE_URL;
      setOrDelete(env, "ANTHROPIC_CUSTOM_HEADERS", otherHeaderLines(env.ANTHROPIC_CUSTOM_HEADERS).join("\n"));
    }
  }
  if (Object.keys(env).length) settings.env = env;
  else delete settings.env;
  writeJson(file, settings, enabled ? { mode: SECRET_MODE } : {});
  return true;
}

/** OpenCode documents `provider.<id>.options.baseURL` and `options.headers`. */
function wireOpencode(home, { enabled, port, key }) {
  const file = opencodeConfigPath(home);
  const current = fs.existsSync(file) ? parseJsonc(fs.readFileSync(file, "utf8"))?.provider : undefined;
  const options = current?.anthropic?.options || {};
  const pointed = LOOPBACK_URL.test(String(options.baseURL || ""));
  const backup = readBackup(home);
  if (!enabled && !(pointed && options.headers?.[HEADER_NAME])) return false;
  if (enabled && !pointed && !backup.opencode && (options.baseURL !== undefined || options.headers?.[HEADER_NAME] !== undefined)) {
    backup.opencode = { baseURL: options.baseURL, header: options.headers?.[HEADER_NAME] };
    writeBackup(home, backup);
  }
  const saved = enabled ? undefined : backup.opencode;
  mergeOpencodeConfig(home, "provider", (existing) => {
    const provider = { ...(existing || {}) };
    const anthropic = { ...(provider.anthropic || {}) };
    const next = { ...(anthropic.options || {}) };
    const headers = { ...(next.headers || {}) };
    if (enabled) {
      next.baseURL = `http://127.0.0.1:${port}/v1`;
      headers[HEADER_NAME] = `Bearer ${key}`;
    } else {
      setOrDelete(next, "baseURL", saved?.baseURL);
      setOrDelete(headers, HEADER_NAME, saved?.header);
    }
    if (Object.keys(headers).length) next.headers = headers;
    else delete next.headers;
    if (Object.keys(next).length) anthropic.options = next;
    else delete anthropic.options;
    if (Object.keys(anthropic).length) provider.anthropic = anthropic;
    else delete provider.anthropic;
    return provider;
  }, enabled ? { mode: SECRET_MODE } : {});
  if (saved) {
    delete backup.opencode;
    writeBackup(home, backup);
  }
  return true;
}

/** `text` with `line` after the last top-level key/value pair (else at the start), so the key stays top-level. */
function withTopLevelLine(text, line) {
  const statements = tomlStatements(text);
  const firstTable = statements.findIndex((st) => st.kind !== "kv");
  const topLevel = firstTable < 0 ? statements : statements.slice(0, firstTable);
  const at = topLevel.length ? topLevel.at(-1).end : 0;
  const head = text.slice(0, at);
  return `${head}${head && !head.endsWith("\n") ? "\n" : ""}${line}\n${text.slice(at)}`;
}

/** `text` without the top-level `model_provider` and without `[model_providers.openmem]`. */
function withoutCodexWiring(text) {
  const spans = [
    ...tomlSpansUnder(text, ["model_providers", CODEX_PROVIDER_ID]),
    ...tomlStatements(text).filter((st) => st.kind === "kv" && st.path.length === 1 && st.path[0] === "model_provider"),
  ];
  return removeSpans(text, spans);
}

/**
 * Codex: `model_provider = "openmem"` and `[model_providers.openmem]` (ChatGPT login kept, LiteLLM key in
 * `http_headers`). A foreign `model_provider` is backed up and restored on disable. A config the TOML
 * parser rejects is left alone with a warning.
 */
function wireCodex(home, { enabled, port, key, h }) {
  const file = codexConfigPath(home);
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  let cfg;
  try {
    cfg = text ? TOML.parse(text) : {};
  } catch (err) {
    h?.warn(`codex: left ${file} unchanged; cannot parse it (${err.message})`);
    return false;
  }
  const pointed = codexPointed(cfg);
  if (!enabled && !pointed) return false;
  const backup = readBackup(home);
  const rest = withoutCodexWiring(text).trimEnd();
  const base = rest ? `${rest}\n` : "";
  let next;
  if (enabled) {
    if (!pointed && cfg.model_provider !== undefined && !backup.codex) {
      backup.codex = { model_provider: cfg.model_provider };
      writeBackup(home, backup);
    }
    const section = [
      `[model_providers.${CODEX_PROVIDER_ID}]`,
      'name = "OpenMem context proxy"',
      `base_url = ${JSON.stringify(`http://127.0.0.1:${port}/backend-api/codex`)}`,
      'wire_api = "responses"',
      "requires_openai_auth = true",
      "supports_websockets = false",
      `http_headers = { ${JSON.stringify(HEADER_NAME)} = ${JSON.stringify(`Bearer ${key}`)} }`,
    ].join("\n");
    next = `${withTopLevelLine(base, `model_provider = ${JSON.stringify(CODEX_PROVIDER_ID)}`)}\n${section}\n`;
  } else {
    const saved = backup.codex?.model_provider;
    next = typeof saved === "string" && saved ? withTopLevelLine(base, `model_provider = ${JSON.stringify(saved)}`) : base;
    if (backup.codex) {
      delete backup.codex;
      writeBackup(home, backup);
    }
  }
  TOML.parse(next);
  writeFileAtomic(file, next, enabled ? { mode: SECRET_MODE } : {});
  return true;
}

/** Base URL an agent is pointed at: the proxy root, or the Codex subscription pass-through. */
const proxyUrl = (id, port) => `http://127.0.0.1:${port}${id === "codex" ? "/backend-api/codex" : ""}`;

/**
 * Enable: write the key file and proxy settings. Disable: remove exactly those settings
 * when they still point at the loopback proxy, restoring backed-up values; the key file is kept.
 * OpenCode 2 trims in OpenMem's plugin, so it is never pointed at the proxy and earlier
 * proxy settings are removed; such agents are returned in `pluginTrimmed`.
 */
export function installContextProxy({ home, agents, enabled, agentEnabled = {}, port, dry = false, h, opencodeMajor = 1 }) {
  const targets = agents.filter((id) => PROXY_AGENT_IDS.includes(id));
  const isOpencode2 = (id) => id === "opencode" && opencodeMajor >= 2;
  // Per-agent choice ({ "claude-code"?, opencode?, codex? }); a missing entry uses `enabled`.
  const on = (id) => (typeof agentEnabled[id] === "boolean" ? agentEnabled[id] : Boolean(enabled));
  const pluginTrimmed = targets.filter(isOpencode2);
  if (dry) {
    for (const id of targets) {
      if (isOpencode2(id)) h?.info(`[dry-run] ${id}: OpenCode 2 trims natively; not pointed at the context proxy`);
      else h?.info(`[dry-run] ${on(id) ? "point" : "unpoint"} ${id} ${on(id) ? "at" : "from"} context proxy ${proxyUrl(id, port)}`);
    }
    return { changed: [], pluginTrimmed };
  }
  const anyOn = targets.some((id) => !isOpencode2(id) && on(id));
  const key = anyOn ? ensureContextProxyKey(home) : "";
  // compose mounts this with create_host_path: false, so it must exist (700, host-owned) before `up`.
  if (anyOn) {
    for (const sub of ["sessions", "blobs"]) fs.mkdirSync(path.join(contextRoot(home), sub), { recursive: true, mode: 0o700 });
  }
  const changed = [];
  for (const id of targets) {
    if (isOpencode2(id)) {
      if (wireOpencode(home, { enabled: false, port, key })) h?.ok(`${id}: removed context proxy settings (OpenCode 2 trims natively)`);
      if (on(id)) h?.info(`${id}: OpenCode 2 trims natively; not pointed at the context proxy`);
      continue;
    }
    const enable = on(id);
    const wire = { "claude-code": wireClaude, opencode: wireOpencode, codex: wireCodex }[id];
    const done = wire(home, { enabled: enable, port, key, h });
    if (!done) continue;
    changed.push(id);
    h?.ok(`${id}: context proxy ${enable ? `→ ${proxyUrl(id, port)}` : "settings removed"}`);
  }
  return { changed, pluginTrimmed };
}
