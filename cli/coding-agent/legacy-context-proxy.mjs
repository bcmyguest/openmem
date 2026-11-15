/**
 * Detect agent settings left pointing at the context proxy that earlier releases installed.
 * Read-only: the proxy is gone, and editing these settings could also hit another tool's loopback
 * proxy (e.g. smarter-compact), so the installer only warns and names the manual fix.
 */
import fs from "node:fs";
import path from "node:path";
import TOML from "@iarna/toml";
import { readJson } from "./file-io.mjs";
import { opencodeConfigPath, parseJsonc } from "./opencode-config.mjs";

const DEFAULT_PORT = 4100;
/** `model_provider` id earlier releases wrote into ~/.codex/config.toml. */
const CODEX_PROVIDER_ID = "openmem";

/** `[context_proxy] port` from config.toml, else the old default 4100. */
function legacyPort(cfg) {
  const port = Number(cfg?.context_proxy?.port);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
}

/** Run `read`; an unreadable or malformed file counts as not pointed. */
function safely(read) {
  try {
    return read();
  } catch {
    return false;
  }
}

/**
 * Agents still pointed at the removed proxy, each with the setting to fix. Claude Code and
 * OpenCode match only the exact URL earlier releases wrote for that port.
 * @param {string} home
 * @param {Record<string, unknown>} cfg merged config.toml
 * @returns {{ agent: string, file: string, setting: string }[]}
 */
export function agentsOnLegacyContextProxy(home, cfg) {
  const base = `http://127.0.0.1:${legacyPort(cfg)}`;
  const out = [];
  const claude = path.join(home, ".claude", "settings.json");
  if (safely(() => readJson(claude).env?.ANTHROPIC_BASE_URL === base)) {
    out.push({ agent: "claude-code", file: claude, setting: "env.ANTHROPIC_BASE_URL and env.ANTHROPIC_CUSTOM_HEADERS" });
  }
  const opencode = opencodeConfigPath(home);
  if (safely(() => parseJsonc(fs.readFileSync(opencode, "utf8"))?.provider?.anthropic?.options?.baseURL === `${base}/v1`)) {
    out.push({ agent: "opencode", file: opencode, setting: "provider.anthropic.options.baseURL and its x-litellm-api-key header" });
  }
  const codex = path.join(home, ".codex", "config.toml");
  if (safely(() => {
    const doc = TOML.parse(fs.readFileSync(codex, "utf8"));
    return doc.model_provider === CODEX_PROVIDER_ID || Boolean(doc.model_providers?.[CODEX_PROVIDER_ID]);
  })) {
    out.push({ agent: "codex", file: codex, setting: `model_provider = "${CODEX_PROVIDER_ID}" and [model_providers.${CODEX_PROVIDER_ID}]` });
  }
  return out;
}

/** Path of the pre-proxy values earlier releases saved; the user restores them by hand. */
export function legacyContextProxyBackupPath(home) {
  return path.join(home, ".config", "personal-memory", "context-proxy-backup.json");
}
