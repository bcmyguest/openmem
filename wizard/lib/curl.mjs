import { spawnSync } from "node:child_process";

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
  const args = ["-fsS", "-m", String(timeoutSec), "-X", method, url];
  if (jsonBody !== undefined) {
    args.push("-H", "Content-Type: application/json", "-d", jsonBody);
  }
  const r = spawnSync("curl", args, { encoding: "utf8" });
  if (r.status !== 0) return "";
  return r.stdout || "";
}
