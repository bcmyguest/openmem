/** mem0's contribution to the wizard's closing summary. */
import path from "node:path";
import { resolveEnvFile, ensureState } from "./state.mjs";
import { containerUrl, displayUrl, resolveApiUrl, urlProblem } from "./url.mjs";

/** @typedef {import("../../../wizard/lib/provider-wizard/helpers.mjs").ProviderWizardHelpers} Helpers */

const DOCS = "https://docs.mem0.ai/open-source/features/rest-api";

/**
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 * @returns {{ running: string[], configFiles: string[], notes: string[], logServices: string[] }}
 */
export function summary(ctx, h) {
  ensureState(ctx);
  const raw = resolveApiUrl(ctx, h);
  const valid = !urlProblem(raw);
  const url = valid ? displayUrl(raw) : "(invalid URL)";
  const envFile = resolveEnvFile(ctx, h);

  const running = [
    `  mem0 API           ${url}  external server (not managed by this stack)`,
    `  indexer sink       mem0 -> ${valid ? containerUrl(raw) : "(invalid URL)"} (the container's view)`,
  ];
  const configFiles = [
    `  ${envFile} (MEM0_API_KEY for the indexer, mode 600)`,
    `  ${path.join(ctx.repoRoot, ".env")} (MEM0_API_URL, MEM0_INDEXER_URL; no secrets)`,
  ];

  /** @type {string[]} */
  const notes = [];
  let hostname = "<host>";
  let loopback = false;
  if (valid) {
    const parsed = new URL(raw);
    hostname = parsed.hostname;
    loopback = ["127.0.0.1", "localhost", "0.0.0.0", "[::1]"].includes(hostname);
  }
  notes.push(
    `API key: create one in the mem0 dashboard (http://${hostname}:3000) or with POST /api-keys, then put MEM0_API_KEY=<key> in ${envFile} (mode 600). ` +
      "A server run with AUTH_DISABLED=true needs none (development only).",
    `The mem0 server is yours to run: its first-time setup (JWT_SECRET, embedder keys) is provider-native, see ${DOCS}`,
    loopback
      ? "The indexer container reaches a loopback server as host.docker.internal; on Linux a server bound only to 127.0.0.1 is not reachable that way: bind it to 0.0.0.0 or the docker bridge IP, or use a hostname in MEM0_API_URL."
      : "The indexer container must be able to reach the server at the URL above (it uses the same host name).",
  );
  return { running, configFiles, notes, logServices: ["indexer"] };
}
