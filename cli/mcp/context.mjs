import path from "node:path";
import { envValue } from "../../wizard/lib/paths.mjs";
import { resolveMemoryProvider } from "../install-memory-mcp.mjs";
import { resolveMem0ApiUrl, resolveMem0EnvFilePath } from "../../providers/mem0/lib/mcp-install.mjs";
import { resolveCogneeApiUrl } from "../../providers/cognee/lib/cognee-mcp-install.mjs";
import { readKey } from "../../providers/mem0/lib/env-file.mjs";

const DEFAULT_HINDSIGHT_PORT = 8888;

/**
 * @param {{ home: string, stackRoot: string, env?: NodeJS.ProcessEnv }} opts
 */
export function resolveHindsightApiUrl({ home, stackRoot, env = process.env }) {
  const candidates = [
    env.HINDSIGHT_URL,
    env.PM_HINDSIGHT_URL,
    envValue(path.join(stackRoot, ".env"), "HINDSIGHT_URL"),
    envValue(path.join(home, ".config/hindsight/wizard.conf"), "HINDSIGHT_URL"),
  ];
  const url = candidates.map((v) => String(v || "").trim()).find(Boolean);
  if (url) return url.replace(/\/+$/, "");
  const portCandidates = [
    env.HINDSIGHT_PORT,
    envValue(path.join(stackRoot, ".env"), "HINDSIGHT_PORT"),
    envValue(path.join(home, ".config/hindsight/wizard.conf"), "HINDSIGHT_PORT"),
  ];
  const port = portCandidates.map((v) => String(v || "").trim()).find(Boolean) || String(DEFAULT_HINDSIGHT_PORT);
  return `http://127.0.0.1:${port}`;
}

/**
 * @param {{ home: string, stackRoot: string, repoRoot: string, env?: NodeJS.ProcessEnv }} opts
 */
export function resolveMcpContext(opts) {
  const env = opts.env || process.env;
  const home = opts.home;
  const stackRoot = opts.stackRoot;
  const provider = resolveMemoryProvider(home, env);
  /** @type {{ provider: string, hindsightUrl?: string, mem0?: { baseUrl: string, apiKey?: string }, cognee?: { baseUrl: string, apiKey?: string } }} */
  const ctx = { provider };
  if (provider === "hindsight") {
    ctx.hindsightUrl = resolveHindsightApiUrl({ home, stackRoot, env });
  } else if (provider === "mem0") {
    const baseUrl = resolveMem0ApiUrl({ home, stackRoot, env });
    const envFile = resolveMem0EnvFilePath({ home, stackRoot, env });
    let apiKey = String(env.MEM0_API_KEY || "").trim();
    if (!apiKey) {
      try {
        apiKey = readKey(envFile) || "";
      } catch {
        apiKey = "";
      }
    }
    ctx.mem0 = { baseUrl, apiKey: apiKey || undefined };
  } else if (provider === "cognee") {
    const baseUrl = resolveCogneeApiUrl({ home, stackRoot, repoRoot: opts.repoRoot, env });
    const apiKey = String(env.COGNEE_API_KEY || "").trim() || undefined;
    ctx.cognee = { baseUrl, apiKey };
  }
  return ctx;
}
