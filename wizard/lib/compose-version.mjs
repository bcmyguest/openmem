/**
 * Docker Compose version gate for the wizard preflight.
 *
 * Provider compose fragments use `env_file: [{path, required: false}]`, which needs Compose 2.24;
 * the Hindsight base file already needs 2.20 for `depends_on.required`. The wizard requires the
 * higher bar everywhere so a stack never fails halfway through `docker compose up`.
 */

export const MIN_COMPOSE = { major: 2, minor: 24 };

/**
 * Parse `docker compose version --short` ("2.29.0", "v2.29.0") or the long form
 * ("Docker Compose version v2.29.0"). Returns null when no version is found.
 * @param {string} text
 * @returns {{major:number, minor:number}|null}
 */
export function parseComposeVersion(text) {
  const m = String(text || "").match(/v?(\d+)\.(\d+)/);
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

/**
 * @param {{major:number, minor:number}|null} version
 * @returns {boolean} true when the version meets MIN_COMPOSE
 */
export function composeVersionOk(version) {
  if (!version) return false;
  if (version.major !== MIN_COMPOSE.major) return version.major > MIN_COMPOSE.major;
  return version.minor >= MIN_COMPOSE.minor;
}

export const COMPOSE_TOO_OLD_HINT = `Docker Compose ${MIN_COMPOSE.major}.${MIN_COMPOSE.minor} or newer is required (docker compose version --short); provider compose files use env_file required: false. Update the compose plugin`;
