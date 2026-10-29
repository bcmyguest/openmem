/**
 * Point Claude Code and OpenCode at the local LiteLLM context proxy, or undo that.
 * Codex stays hook-only until a stable LiteLLM forwards ChatGPT-login auth.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { mergeOpencodeConfig, opencodeConfigPath, parseJsonc } from "./opencode-config.mjs";

const KEY_NAME = "LITELLM_MASTER_KEY";
const HEADER_NAME = "x-litellm-api-key";
const LOOPBACK_URL = /^http:\/\/127\.0\.0\.1:\d+(?:\/v1)?$/;

export function contextProxyEnvPath(home) {
  return path.join(home, ".config", "personal-memory", "context-proxy.env");
}

/** Return the master key from context-proxy.env, generating the file (mode 600) once. */
export function ensureContextProxyKey(home) {
  const file = contextProxyEnvPath(home);
  if (fs.existsSync(file)) {
    const line = fs.readFileSync(file, "utf8").split(/\r?\n/).find((l) => l.startsWith(`${KEY_NAME}=`));
    const key = line?.slice(KEY_NAME.length + 1).trim();
    if (key) {
      fs.chmodSync(file, 0o600);
      return key;
    }
  }
  const key = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const previous = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  fs.writeFileSync(file, `${previous && !previous.endsWith("\n") ? `${previous}\n` : previous}${KEY_NAME}=${key}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return key;
}

function readJson(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function wireClaude(home, { enabled, port, key }) {
  const file = path.join(home, ".claude", "settings.json");
  const settings = readJson(file);
  const env = { ...(settings.env || {}) };
  if (enabled) {
    env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
    env.ANTHROPIC_CUSTOM_HEADERS = `${HEADER_NAME}: Bearer ${key}`;
  } else {
    const ours = LOOPBACK_URL.test(String(env.ANTHROPIC_BASE_URL || ""))
      && String(env.ANTHROPIC_CUSTOM_HEADERS || "").startsWith(`${HEADER_NAME}: Bearer `);
    if (!ours) return false;
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_CUSTOM_HEADERS;
  }
  if (Object.keys(env).length) settings.env = env;
  else delete settings.env;
  writeJson(file, settings);
  return true;
}

/** OpenCode documents `provider.<id>.options.baseURL` and `options.headers`. */
function wireOpencode(home, { enabled, port, key }) {
  const file = opencodeConfigPath(home);
  const current = fs.existsSync(file) ? parseJsonc(fs.readFileSync(file, "utf8"))?.provider : undefined;
  const options = current?.anthropic?.options || {};
  if (!enabled) {
    const ours = LOOPBACK_URL.test(String(options.baseURL || "")) && options.headers?.[HEADER_NAME];
    if (!ours) return false;
  }
  mergeOpencodeConfig(home, "provider", (existing) => {
    const provider = { ...(existing || {}) };
    const anthropic = { ...(provider.anthropic || {}) };
    const next = { ...(anthropic.options || {}) };
    const headers = { ...(next.headers || {}) };
    if (enabled) {
      next.baseURL = `http://127.0.0.1:${port}/v1`;
      headers[HEADER_NAME] = `Bearer ${key}`;
    } else {
      delete next.baseURL;
      delete headers[HEADER_NAME];
    }
    if (Object.keys(headers).length) next.headers = headers;
    else delete next.headers;
    if (Object.keys(next).length) anthropic.options = next;
    else delete anthropic.options;
    if (Object.keys(anthropic).length) provider.anthropic = anthropic;
    else delete provider.anthropic;
    return provider;
  });
  return true;
}

/**
 * Enable: write the key file and proxy settings. Disable: remove exactly those settings
 * when they still point at the loopback proxy; the key file is kept for a later enable.
 */
export function installContextProxy({ home, agents, enabled, port, dry = false, h }) {
  const targets = agents.filter((id) => id === "claude-code" || id === "opencode");
  if (dry) {
    for (const id of targets) h?.info(`[dry-run] ${enabled ? "point" : "unpoint"} ${id} ${enabled ? "at" : "from"} context proxy http://127.0.0.1:${port}`);
    return { changed: [] };
  }
  const key = enabled ? ensureContextProxyKey(home) : "";
  const changed = [];
  for (const id of targets) {
    const done = id === "claude-code" ? wireClaude(home, { enabled, port, key }) : wireOpencode(home, { enabled, port, key });
    if (!done) continue;
    changed.push(id);
    h?.ok(`${id}: context proxy ${enabled ? `→ http://127.0.0.1:${port}` : "settings removed"}`);
  }
  return { changed };
}
