import fs from "node:fs";
import path from "node:path";
import TOML from "@iarna/toml";
import { writeFileAtomic } from "../../cli/coding-agent/file-io.mjs";
import { DEFAULT_PROVIDER_ID } from "./providers/registry.mjs";

/** Tables owned by install-coding-agent; the wizard carries them over when it rewrites the file. */
const INSTALLER_TABLES = ["agents", "context_proxy", "compaction", "context_store"];
const AGENT_INTEGRATIONS = ["openmem", "provider"];
const DEFAULT_CONTEXT_PROXY_PORT = 4100;
/** `[context_proxy.agents]` keys. opencode2 trims in its plugin; the others route through the proxy service. */
export const CONTEXT_AGENT_KEYS = ["claude-code", "opencode1", "codex", "opencode2"];
export const CONTEXT_PROXY_AGENT_KEYS = ["claude-code", "opencode1", "codex"];
// Same defaults as proxy/openmem_context/settings.py and cli/coding-agent/context-trim.mjs.
const DEFAULT_TRIM_AT_TOKENS = 120000;
const DEFAULT_COMPRESS_OVER_TOKENS = 4000;
const DEFAULT_COMPACTION_MAX_CHARS = 12000;
/** Config keys that reach the proxy container (stack .env) and the OpenCode 2 plugin as env. */
const CONTEXT_TRIM_ENV_KEYS = [
  ["context_proxy", "trim_at_tokens", "CONTEXT_TRIM_AT_TOKENS"],
  ["context_proxy", "compress_over_tokens", "CONTEXT_COMPRESS_OVER_TOKENS"],
  ["compaction", "max_chars", "CONTEXT_COMPACTION_MAX_CHARS"],
  ["context_store", "ttl_days", "CONTEXT_STORE_TTL_DAYS"],
  ["context_store", "embedding_max_chars", "CONTEXT_EMBEDDING_MAX_CHARS"],
];
/** String keys of `[context_store]` and their env names (session database vectors, docs/context-store.md). */
const CONTEXT_STORE_STRING_KEYS = [
  ["embedding_model", "CONTEXT_EMBEDDING_MODEL"],
  ["embedding_url", "CONTEXT_EMBEDDING_URL"],
];
const CONFIG_MODE = 0o600;
const CONFIG_HEADER = "# Written by openmem — mise-like config.\n# Docs: docs/openmem-config.md\n";

/** @param {string} home */
export function userConfigPath(home) {
  return path.join(home, ".config/personal-memory/config.toml");
}

/** @param {string} repoRoot */
export function projectConfigPaths(repoRoot) {
  return [
    path.join(repoRoot, "openmem.toml"),
    path.join(repoRoot, "config/openmem.toml"),
    // Pre-rebrand filenames still load if present.
    path.join(repoRoot, "personal-memory.toml"),
    path.join(repoRoot, "config/personal-memory.toml"),
  ];
}

/**
 * @param {string} file
 * @returns {Record<string, unknown>}
 */
function readTomlFile(file) {
  if (!fs.existsSync(file)) return {};
  try {
    return TOML.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file}: ${/** @type {Error} */ (e).message}`);
  }
}

/** Atomic rewrite; a new file is created mode 600, an existing one keeps its mode. */
function writeConfigFile(file, text) {
  writeFileAtomic(file, text, fs.existsSync(file) ? {} : { mode: CONFIG_MODE });
}

/** @param {Record<string, unknown>} base @param {Record<string, unknown>} over */
function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object") {
      out[k] = deepMerge(/** @type {Record<string, unknown>} */ (out[k]), /** @type {Record<string, unknown>} */ (v));
    } else out[k] = v;
  }
  return out;
}

/**
 * @param {string} home
 * @param {string} repoRoot
 * @returns {{ merged: Record<string, unknown>, userPath: string, wroteFrom: string[] }}
 */
export function loadPmConfig(home, repoRoot) {
  let merged = {};
  const wroteFrom = [];
  for (const p of projectConfigPaths(repoRoot)) {
    if (fs.existsSync(p)) {
      merged = deepMerge(merged, readTomlFile(p));
      wroteFrom.push(p);
    }
  }
  const userPath = userConfigPath(home);
  if (fs.existsSync(userPath)) {
    merged = deepMerge(merged, readTomlFile(userPath));
    wroteFrom.push(userPath);
  }
  return { merged, userPath, wroteFrom };
}

/**
 * Flat defaults for the wizard (--yes / Clack initialValue). Provider-specific tables
 * ([model], provider ports) are read by the provider's own hooks from `cfg`.
 * @param {Record<string, unknown>} cfg
 */
export function defaultsFromPmConfig(cfg) {
  const memory = /** @type {Record<string, unknown>} */ (cfg.memory || {});
  const stack = /** @type {Record<string, unknown>} */ (cfg.stack || {});
  const wizard = /** @type {Record<string, unknown>} */ (cfg.wizard || {});

  return {
    memoryProvider: String(memory.provider || ""),
    stackProject: String(stack.project || ""),
    wizardAction: String(wizard.action || ""),
  };
}

/**
 * @param {import("./run-wizard.mjs").WizardContext} ctx
 * @param {Record<string, Record<string, unknown>>} [sections] provider-owned tables:
 *   `stack` keys are merged into [stack]; `memory` sub-tables (for example `memory.mem0`) are
 *   merged into [memory], and `provider` there is always the active provider id; every other
 *   key becomes its own top-level table
 * @returns {string}
 */
export function buildPmConfigToml(ctx, sections = {}) {
  const { stack: stackExtra = {}, memory: memoryExtra = {}, ...rest } = sections;
  const doc = {
    memory: { ...memoryExtra, provider: ctx.memoryProvider?.id || DEFAULT_PROVIDER_ID },
    stack: { project: ctx.project, ...stackExtra },
    wizard: { action: ctx.action || "configure" },
    ...rest,
    tasks: {
      configure: { description: "Secrets, index sources, build images, compose up" },
      up: { description: "Start stack using existing config" },
      down: { description: "docker compose down for this project" },
      doctor: { description: "Validate memory setup on this machine" },
    },
  };
  return `# Written by ./setup — mise-like config for openmem.\n# Docs: docs/openmem-config.md\n${TOML.stringify(doc)}`;
}

/**
 * @param {import("./run-wizard.mjs").WizardContext} ctx
 * @param {Record<string, Record<string, unknown>>} [sections] see buildPmConfigToml
 */
export function syncPmConfig(ctx, sections = {}) {
  if (ctx.dry) return;
  const dir = path.dirname(userConfigPath(ctx.home));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = userConfigPath(ctx.home);
  let previous = {};
  try {
    previous = readTomlFile(file);
  } catch {
    // A malformed file is replaced, as before; nothing to carry over.
  }
  const kept = Object.fromEntries(
    INSTALLER_TABLES.filter((t) => previous[t] && !(t in sections)).map((t) => [t, previous[t]]),
  );
  writeConfigFile(file, buildPmConfigToml(ctx, { ...sections, ...kept }));
}

/**
 * Minimal in-place update of `memory.provider` in the user config.toml when the file
 * already exists. Does not create the file (unlike syncPmConfig).
 *
 * @param {string} home
 * @param {string} providerId
 * @param {{ dry?: boolean }} [opts]
 * @returns {"updated"|"skipped"|"dry-run"}
 */
export function updatePmConfigProvider(home, providerId, opts = {}) {
  const file = userConfigPath(home);
  if (!fs.existsSync(file)) return "skipped";
  if (opts.dry) return "dry-run";
  const doc = readTomlFile(file);
  const memory = {
    ...(doc.memory && typeof doc.memory === "object" && !Array.isArray(doc.memory)
      ? /** @type {Record<string, unknown>} */ (doc.memory)
      : {}),
    provider: providerId,
  };
  doc.memory = memory;
  writeConfigFile(file, `${CONFIG_HEADER}${TOML.stringify(doc)}`);
  return "updated";
}

/**
 * Merge `values` into one top-level table of the user config.toml, creating the file
 * (mode 600, directory 700) when it is missing. Other tables are kept.
 *
 * @param {string} home
 * @param {string} table
 * @param {Record<string, unknown>} values
 * @param {{ dry?: boolean }} [opts]
 * @returns {"updated"|"dry-run"}
 */
export function updatePmConfigTable(home, table, values, opts = {}) {
  if (opts.dry) return "dry-run";
  const file = userConfigPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const doc = readTomlFile(file);
  const current = doc[table] && typeof doc[table] === "object" && !Array.isArray(doc[table])
    ? /** @type {Record<string, unknown>} */ (doc[table])
    : {};
  doc[table] = { ...current, ...values };
  writeConfigFile(file, `${CONFIG_HEADER}${TOML.stringify(doc)}`);
  return "updated";
}

/**
 * Write per-agent context management values into `[context_proxy.agents]` (merged with saved keys) and set
 * `[context_proxy] enabled` to whether any agent resolves on. Other `[context_proxy]` keys are kept.
 * @param {string} home
 * @param {Record<string, boolean>} values keys from CONTEXT_AGENT_KEYS
 * @param {{ dry?: boolean }} [opts]
 * @returns {{ result: "updated"|"dry-run", agents: Record<string, boolean>, enabled: boolean }}
 */
export function updatePmConfigContextAgents(home, values, opts = {}) {
  const file = userConfigPath(home);
  const doc = fs.existsSync(file) ? readTomlFile(file) : {};
  const current = contextAgentsFromPmConfig(doc).agents;
  const agents = { ...current, ...values };
  const enabled = CONTEXT_AGENT_KEYS.some((k) => agents[k]);
  const result = updatePmConfigTable(home, "context_proxy", { enabled, agents }, opts);
  return { result, agents, enabled };
}

/**
 * `[agents] integration`: "openmem" (OpenMem hooks) or "provider" (the provider's own plugin).
 * @param {Record<string, unknown>} cfg
 */
export function agentIntegrationFromPmConfig(cfg) {
  const value = String(/** @type {Record<string, unknown>} */ (cfg.agents || {}).integration || "");
  return AGENT_INTEGRATIONS.includes(value) ? value : "openmem";
}

/** @param {Record<string, unknown>} cfg @param {string} name */
function tableOf(cfg, name) {
  const t = cfg?.[name];
  return t && typeof t === "object" && !Array.isArray(t) ? /** @type {Record<string, unknown>} */ (t) : {};
}

/** A non-negative integer config value, or undefined when unset or invalid. */
function countValue(value) {
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "string") return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

/**
 * `[context_proxy]` wiring with defaults: disabled, port 4100.
 * @param {Record<string, unknown>} cfg
 */
export function contextProxyFromPmConfig(cfg) {
  const table = tableOf(cfg, "context_proxy");
  const port = Number(table.port);
  return {
    enabled: table.enabled === true,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_CONTEXT_PROXY_PORT,
  };
}

/**
 * Per-agent context management: `[context_proxy.agents] <key> = true|false`, a missing key following
 * `[context_proxy] enabled`; with neither set, opencode2 is on (it needs no service) and the proxy-routed
 * agents are off. Keys: CONTEXT_AGENT_KEYS. `saved` lists the keys that config.toml sets.
 * @param {Record<string, unknown>} cfg
 * @returns {{ agents: Record<string, boolean>, saved: string[], enabledSaved: boolean }}
 */
export function contextAgentsFromPmConfig(cfg) {
  const table = tableOf(cfg, "context_proxy");
  const overrides = tableOf(table, "agents");
  const enabledSaved = typeof table.enabled === "boolean";
  const agents = {};
  const saved = [];
  for (const key of CONTEXT_AGENT_KEYS) {
    if (typeof overrides[key] === "boolean") {
      agents[key] = overrides[key];
      saved.push(key);
    } else agents[key] = enabledSaved ? table.enabled : key === "opencode2";
  }
  return { agents, saved, enabledSaved };
}

/**
 * Trim settings with defaults: `[context_proxy] trim_at_tokens` (120000), `compress_over_tokens`
 * (4000), `standing_instruction` (true), `[compaction] max_chars` (12000), `native` (true). Env overrides are applied by
 * `contextTrimEnvFromPmConfig` + `trimSettings()`, not here.
 * @param {Record<string, unknown>} cfg
 */
export function contextTrimFromPmConfig(cfg) {
  const proxy = tableOf(cfg, "context_proxy");
  const compaction = tableOf(cfg, "compaction");
  return {
    trimAtTokens: countValue(proxy.trim_at_tokens) ?? DEFAULT_TRIM_AT_TOKENS,
    compressOverTokens: countValue(proxy.compress_over_tokens) ?? DEFAULT_COMPRESS_OVER_TOKENS,
    compactionMaxChars: countValue(compaction.max_chars) ?? DEFAULT_COMPACTION_MAX_CHARS,
    compactionNative: compaction.native !== false,
    standingInstruction: proxy.standing_instruction !== false,
  };
}

/**
 * Context-trim settings that config.toml sets, as the environment variables the proxy and
 * `trimSettings()` read: `[context_proxy] trim_at_tokens` → CONTEXT_TRIM_AT_TOKENS,
 * `compress_over_tokens` → CONTEXT_COMPRESS_OVER_TOKENS, `[compaction] max_chars` →
 * CONTEXT_COMPACTION_MAX_CHARS, `[context_proxy] standing_instruction` (boolean) →
 * CONTEXT_STANDING_INSTRUCTION ("1" / "0"), `[compaction] recall` (boolean) → CONTEXT_COMPACTION_RECALL
 * ("1" / "0"), `[context_proxy] chars_per_token` (positive number) →
 * CONTEXT_CHARS_PER_TOKEN, `[context_store] ttl_days` → CONTEXT_STORE_TTL_DAYS, `embedding_model` →
 * CONTEXT_EMBEDDING_MODEL, `embedding_url` → CONTEXT_EMBEDDING_URL, `embedding_timeout_s` (positive number) →
 * CONTEXT_EMBEDDING_TIMEOUT_S, `embedding_max_chars` → CONTEXT_EMBEDDING_MAX_CHARS. Unset or invalid keys are left out, so the reader's defaults
 * apply. Real env vars override: `trimSettings({ ...contextTrimEnvFromPmConfig(cfg), ...process.env })`.
 * @param {Record<string, unknown>} cfg
 * @returns {Record<string, string>}
 */
export function contextTrimEnvFromPmConfig(cfg) {
  const out = {};
  for (const [table, key, envName] of CONTEXT_TRIM_ENV_KEYS) {
    const value = countValue(tableOf(cfg, table)[key]);
    if (value !== undefined) out[envName] = String(value);
  }
  const standing = tableOf(cfg, "context_proxy").standing_instruction;
  if (typeof standing === "boolean") out.CONTEXT_STANDING_INSTRUCTION = standing ? "1" : "0";
  const recall = tableOf(cfg, "compaction").recall;
  if (typeof recall === "boolean") out.CONTEXT_COMPACTION_RECALL = recall ? "1" : "0";
  const ratio = tableOf(cfg, "context_proxy").chars_per_token;
  if (typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0) out.CONTEXT_CHARS_PER_TOKEN = String(ratio);
  const store = tableOf(cfg, "context_store");
  const timeout = store.embedding_timeout_s;
  if (typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0) out.CONTEXT_EMBEDDING_TIMEOUT_S = String(timeout);
  for (const [key, envName] of CONTEXT_STORE_STRING_KEYS) {
    if (typeof store[key] === "string") out[envName] = store[key].trim();
  }
  return out;
}

/**
 * Stack .env entries for the context-proxy compose service: the trim env above plus
 * CONTEXT_PROXY_PORT when `[context_proxy] port` is set, so the container binds the port
 * Claude Code is pointed at.
 * @param {Record<string, unknown>} cfg
 * @returns {Record<string, string>}
 */
export function contextProxyStackEnvFromPmConfig(cfg) {
  const out = contextTrimEnvFromPmConfig(cfg);
  if (tableOf(cfg, "context_proxy").port !== undefined) out.CONTEXT_PROXY_PORT = String(contextProxyFromPmConfig(cfg).port);
  return out;
}

/**
 * Apply config defaults into process.env when env/CLI did not set them. Only the
 * provider-neutral keys live here; a provider maps its own tables in its `init` hook.
 * @param {Record<string, unknown>} cfg
 */
export function applyPmConfigEnv(cfg) {
  const d = defaultsFromPmConfig(cfg);
  if (d.memoryProvider && !process.env.MEMORY_PROVIDER) {
    process.env.MEMORY_PROVIDER = d.memoryProvider;
  }
  if (d.stackProject && !process.env.PM_PROJECT) process.env.PM_PROJECT = d.stackProject;
  if (d.wizardAction && !process.env.PM_WIZARD_ACTION) {
    process.env.PM_WIZARD_ACTION = d.wizardAction;
  }
}
