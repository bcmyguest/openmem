import { spawn, spawnSync } from "node:child_process";

/**
 * @param {string} url
 * @param {number} [timeoutSec]
 * @returns {string}
 */
export function curlGet(url, timeoutSec = 5) {
  const r = spawnSync("curl", ["-fsS", "-m", String(timeoutSec), url], {
    encoding: "utf8",
  });
  if (r.status !== 0) return "";
  return r.stdout || "";
}

/**
 * @param {string} url
 * @returns {object|null}
 */
export function curlJson(url) {
  const body = curlGet(url);
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/**
 * @param {string} method
 * @param {string} url
 * @param {string} [jsonBody]
 * @param {number} [timeoutSec]
 * @returns {string}
 */
export function curlRequest(method, url, jsonBody, timeoutSec = 60) {
  const args = curlArgs(method, url, jsonBody, timeoutSec);
  const r = spawnSync("curl", args, { encoding: "utf8" });
  if (r.status !== 0) return "";
  return r.stdout || "";
}

/**
 * Build curl argv for a JSON (or empty-body) request.
 * @param {string} method
 * @param {string} url
 * @param {string} [jsonBody]
 * @param {number} timeoutSec
 * @returns {string[]}
 */
export function curlArgs(method, url, jsonBody, timeoutSec) {
  const args = ["-fsS", "-m", String(timeoutSec), "-X", method, url];
  if (jsonBody !== undefined) {
    args.push("-H", "Content-Type: application/json", "-d", jsonBody);
  }
  return args;
}

/**
 * Like curlRequest, but async with an optional heartbeat so long retains do not look hung.
 *
 * @param {string} method
 * @param {string} url
 * @param {string} [jsonBody]
 * @param {number} [timeoutSec]
 * @param {{ tickSec?: number, onTick?: (info: { elapsed: number, timeoutSec: number }) => void }} [opts]
 * @returns {Promise<string>} response body, or "" on failure / timeout
 */
export function curlRequestProgress(method, url, jsonBody, timeoutSec = 60, opts = {}) {
  const tickSec = opts.tickSec ?? 15;
  const onTick = opts.onTick;
  const args = curlArgs(method, url, jsonBody, timeoutSec);
  return new Promise((resolve) => {
    const child = spawn("curl", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let settled = false;
    const started = Date.now();
    const timer =
      typeof onTick === "function"
        ? setInterval(() => {
            onTick({
              elapsed: Math.round((Date.now() - started) / 1000),
              timeoutSec,
            });
          }, tickSec * 1000)
        : null;

    const finish = (body) => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      resolve(body);
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", () => finish(""));
    child.on("close", (code) => finish(code === 0 ? stdout : ""));
  });
}
