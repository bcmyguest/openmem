/**
 * mem0 checks that run after the meta wizard's provider-neutral validation, plus the
 * `beforeStack` reachability and file-mode checks. Secrets must never be in the stack .env
 * (it is mode 644), only in the mode 600 env file.
 */
import fs from "node:fs";
import path from "node:path";
import { describeError, request } from "./http.mjs";
import { dirTooOpen, fileMode, readKey, tooOpen } from "./env-file.mjs";
import { indexerUrl } from "./stack-env.mjs";
import { defaultEnvFile, ensureState, envFileProblem, resolveEnvFile } from "./state.mjs";
import { displayUrl, resolveApiUrl, urlProblem } from "./url.mjs";

/** @typedef {import("../../../wizard/lib/provider-wizard/helpers.mjs").ProviderWizardHelpers} Helpers */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "0.0.0.0", "[::1]"]);
const HOSTED_MEM0 = /(^|\.)api\.mem0\.ai$/i;

/**
 * Warn when the server does not answer GET /docs; never fails (it may start later) and
 * never sends the key. Also warns about an env file that others can read.
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export async function beforeStack(ctx, h) {
  ensureState(ctx);
  const raw = resolveApiUrl(ctx, h);
  const issue = urlProblem(raw);
  if (issue) {
    h.problem(ctx, `mem0 API URL: ${issue}`);
    return;
  }
  const base = displayUrl(raw);
  const envFile = resolveEnvFile(ctx, h);

  if (ctx.dry) {
    h.info(`[dry-run] check that ${base}/docs answers (a warning only: the server may start later)`);
  } else {
    try {
      const res = await request(base, "GET", "/docs", { timeoutMs: 5000 });
      if (res.ok) h.ok(`mem0 server answers at ${base}`);
      else {
        h.warn(
          `mem0 server at ${base} answered ${res.status} for GET /docs. The indexer keeps retrying; ` +
            "check the URL and that this is a mem0 REST server",
        );
      }
    } catch (e) {
      h.warn(
        `mem0 server is not reachable at ${base} (${describeError(e)}). Start it before indexing; ` +
          "the stack health check waits for it and fails when it never comes up",
      );
    }
  }

  if (tooOpen(envFile)) {
    h.warn(`${envFile} is group/other accessible (mode ${fileMode(envFile).toString(8)}); run: chmod 600 ${envFile}`);
  }
  if (fs.existsSync(envFile) && dirTooOpen(envFile)) {
    h.warn(`${path.dirname(envFile)} is accessible to group or others; run: chmod 700 ${path.dirname(envFile)}`);
  }
}

/**
 * Appends to ctx.validationErrors and ctx.validationChecks.
 * @param {Record<string, any>} ctx
 * @param {Helpers} h
 */
export function validateMem0(ctx, h) {
  ensureState(ctx);
  const errors = (ctx.validationErrors ||= []);
  const checks = (ctx.validationChecks ||= []);

  const apiUrl = resolveApiUrl(ctx, h);
  const issue = urlProblem(apiUrl);
  if (issue) errors.push(`mem0 API URL: ${issue}`);
  else {
    checks.push("mem0 API URL parses");
    try {
      const host = new URL(apiUrl).hostname;
      if (HOSTED_MEM0.test(host)) {
        errors.push(
          "mem0 API URL points at api.mem0.ai (hosted platform); this sink is for the self-hosted REST server only — see providers/mem0/OPERATOR.md",
        );
      } else checks.push("mem0 API URL is not the hosted api.mem0.ai platform");
    } catch {
      // urlProblem already covered unparseable URLs.
    }
  }

  const envFile = resolveEnvFile(ctx, h);
  const fileIssue = envFileProblem(envFile);
  if (fileIssue) errors.push(fileIssue);
  else if (!fs.existsSync(envFile)) {
    checks.push("mem0 env file absent (fine when the server has auth disabled)");
  } else if (tooOpen(envFile)) {
    errors.push(`${envFile} must not be group/other accessible (want mode 600)`);
  } else checks.push("mem0 env file mode 600");

  const stackEnv = path.join(ctx.repoRoot, ".env");
  if (fs.existsSync(stackEnv)) {
    const hostApi = h.envValue(stackEnv, "MEM0_API_URL");
    const indexer = h.envValue(stackEnv, "MEM0_INDEXER_URL");
    for (const key of ["MEM0_INDEXER_URL", "MEM0_API_URL"]) {
      if (!h.envValue(stackEnv, key)) errors.push(`repo .env missing ${key}`);
    }
    if (hostApi && indexer) {
      try {
        const expected = indexerUrl(hostApi);
        if (indexer !== expected) {
          errors.push(
            `repo .env MEM0_INDEXER_URL must match the rewrite of MEM0_API_URL (want ${expected}; rerun ./setup)`,
          );
        } else checks.push("repo .env MEM0_INDEXER_URL matches MEM0_API_URL rewrite");
      } catch (e) {
        errors.push(`repo .env MEM0_API_URL: ${/** @type {Error} */ (e).message}`);
      }
    }
    if (/^\s*(?:export\s+)?MEM0_API_KEY\s*=/m.test(fs.readFileSync(stackEnv, "utf8"))) {
      errors.push("repo .env must not hold MEM0_API_KEY (the stack .env is world-readable; use the mem0 env file)");
    }
    checks.push("repo .env mem0 URLs and no key");
  }

  // A custom key file must reach compose through the stack .env, or a hand-run compose would
  // read the default file while the wizard reads another.
  if (!fileIssue && fs.existsSync(stackEnv) && envFile !== defaultEnvFile(ctx.home)) {
    if (h.envValue(stackEnv, "MEM0_ENV_FILE") !== envFile) {
      errors.push("repo .env MEM0_ENV_FILE does not match the mem0 env file in use (rerun ./setup)");
    } else checks.push("repo .env MEM0_ENV_FILE matches");
  }

  // Cleartext key over non-loopback http (warn only; same guidance as the sink).
  if (!issue && !fileIssue) {
    try {
      const parsed = new URL(apiUrl);
      let hasKey = false;
      try {
        hasKey = readKey(envFile) !== "";
      } catch {
        hasKey = false;
      }
      if (parsed.protocol === "http:" && !LOOPBACK_HOSTS.has(parsed.hostname) && hasKey) {
        h.warn(
          "MEM0_API_URL is plain http to a non-loopback host with an API key set; the key travels in cleartext — prefer https (see providers/mem0/OPERATOR.md)",
        );
      }
    } catch {
      // ignore
    }
  }

  for (const file of ctx.memoryProvider?.compose?.files || []) {
    const abs = path.join(ctx.repoRoot, file);
    if (!fs.existsSync(abs)) errors.push(`missing compose file ${abs}`);
    else checks.push(`compose fragment ${file} present`);
  }
}
