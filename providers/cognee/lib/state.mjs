/**
 * Cognee's slice of the wizard context: defaults, and where the operator env files live.
 *
 * Two optional env files hold every Cognee secret; neither is the stack .env:
 *   cognee.env          loaded by the cognee service (LLM_API_KEY, LLM_*, EMBEDDING_*)
 *   cognee-indexer.env  loaded by the indexer (COGNEE_API_KEY only, when auth is enabled)
 * Their paths follow providers/cognee/compose.yaml: COGNEE_ENV_FILE and
 * COGNEE_INDEXER_ENV_FILE, defaulting to ~/.config/personal-memory/.
 */
import path from "node:path";

export const DEFAULT_PORT = 8766;
export const DEFAULT_ENV_FILE = "~/.config/personal-memory/cognee.env";
export const DEFAULT_INDEXER_ENV_FILE = "~/.config/personal-memory/cognee-indexer.env";

/** Dataset the smoke test creates and deletes. */
export const SMOKE_DATASET = "wizard_smoke";

/**
 * @param {string} p
 * @param {string} home
 */
function expand(p, home) {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

/**
 * Absolute path for an env-file setting: `~` is expanded and a relative path is taken
 * relative to the stack root (compose resolves env_file against its project directory).
 * @param {string} value
 * @param {{ home?: string, repoRoot?: string }} ctx
 */
export function resolveFile(value, ctx) {
  return path.resolve(ctx.repoRoot || "", expand(value, ctx.home || ""));
}

/**
 * Fill the Cognee fields of the wizard context. Idempotent: a field that is already set
 * is kept. The env file paths are recomputed on every call because the environment
 * (COGNEE_ENV_FILE) and the TOML table (applied in `init`) can change between phases.
 * @param {Record<string, any>} ctx
 */
export function ensureState(ctx) {
  const cognee = (ctx.cognee ||= { port: "", envFile: "", indexerEnvFile: "" });
  cognee.envFile = resolveFile(
    process.env.COGNEE_ENV_FILE || cognee.configEnvFile || DEFAULT_ENV_FILE,
    ctx,
  );
  cognee.indexerEnvFile = resolveFile(
    process.env.COGNEE_INDEXER_ENV_FILE || DEFAULT_INDEXER_ENV_FILE,
    ctx,
  );
  if (ctx.portCognee === undefined) ctx.portCognee = "";
  if (ctx.cogneeUrl === undefined) ctx.cogneeUrl = "";
  return ctx;
}

/**
 * The host port in force: the resolved one, else the environment, else the default.
 * @param {Record<string, any>} ctx
 */
export function currentPort(ctx) {
  return String(ctx.portCognee || process.env.COGNEE_PORT || DEFAULT_PORT);
}

/**
 * A path for display and config.toml: `~/...` when it sits under the home directory.
 * @param {string} file
 * @param {string} [home]
 */
export function tildePath(file, home) {
  if (home && (file === home || file.startsWith(`${home}${path.sep}`))) {
    return `~${file.slice(home.length)}`;
  }
  return file;
}
