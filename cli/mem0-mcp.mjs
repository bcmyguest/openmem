#!/usr/bin/env node
/**
 * Stdio launcher for the self-hosted mem0 MCP bridge.
 *
 * Loads MEM0_API_KEY from MEM0_ENV_FILE / ~/.config/personal-memory/mem0.env when unset,
 * maps MEM0_API_URL → MEM0_BASE_URL for @yeyuan98/mem0-mcp, then execs:
 *   npx -y @yeyuan98/mem0-mcp
 *
 * Never prints the API key. Cursor mcp.json must not embed the secret — only the URL
 * and optional MEM0_ENV_FILE path (see providers/mem0/lib/mcp-install.mjs).
 */
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";
import { readKey } from "../providers/mem0/lib/env-file.mjs";
import { MEM0_MCP_NPM_PACKAGE } from "../providers/mem0/lib/mcp-install.mjs";
import { defaultEnvFile } from "../providers/mem0/lib/state.mjs";

const BIN = "mem0-mcp";

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 */
export function resolveEnvFileForLaunch(env = process.env, home = process.env.HOME || os.homedir()) {
  const raw = String(env.MEM0_ENV_FILE || "").trim();
  if (!raw) return defaultEnvFile(home);
  if (raw.startsWith("~/")) return path.join(home, raw.slice(2));
  return path.isAbsolute(raw) ? raw : path.resolve(raw);
}

/**
 * Prepare env for the upstream MCP: BASE_URL + API_KEY. Mutates a shallow copy only.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ env: NodeJS.ProcessEnv, envFile: string, hadKeyInEnv: boolean }}
 */
export function prepareMem0McpEnv(env = process.env) {
  const next = { ...env };
  const apiUrl = String(next.MEM0_API_URL || next.MEM0_BASE_URL || "")
    .trim()
    .replace(/\/+$/, "");
  if (apiUrl) {
    next.MEM0_API_URL = apiUrl;
    next.MEM0_BASE_URL = apiUrl;
  }

  const hadKeyInEnv = Boolean(String(next.MEM0_API_KEY || "").trim());
  const envFile = resolveEnvFileForLaunch(next);
  if (!hadKeyInEnv) {
    const fromFile = readKey(envFile);
    if (fromFile) next.MEM0_API_KEY = fromFile;
  }

  return { env: next, envFile, hadKeyInEnv };
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, spawnFn?: typeof spawn }} [opts]
 * @returns {Promise<number>} exit code
 */
export function runMem0Mcp(opts = {}) {
  const spawnFn = opts.spawnFn || spawn;
  const { env, envFile } = prepareMem0McpEnv(opts.env || process.env);

  if (!String(env.MEM0_BASE_URL || "").trim()) {
    console.error(
      `${BIN}: set MEM0_API_URL or MEM0_BASE_URL to your self-hosted mem0 REST server (e.g. http://127.0.0.1:18888)`,
    );
    return Promise.resolve(1);
  }
  if (!String(env.MEM0_API_KEY || "").trim()) {
    console.error(
      `${BIN}: MEM0_API_KEY missing. Put it in ${envFile} (mode 600) or export it in the agent environment.` +
        ` (AUTH_DISABLED=true servers still need a non-empty placeholder for this MCP bridge.)`,
    );
    return Promise.resolve(1);
  }

  return new Promise((resolve) => {
    const child = spawnFn("npx", ["-y", MEM0_MCP_NPM_PACKAGE], {
      env,
      stdio: "inherit",
      shell: false,
    });
    child.on("error", (err) => {
      console.error(`${BIN}: failed to start npx ${MEM0_MCP_NPM_PACKAGE}: ${err.message}`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      if (signal) resolve(1);
      else resolve(code == null ? 1 : code);
    });
  });
}

async function main() {
  const code = await runMem0Mcp();
  process.exit(code);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`${BIN}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
