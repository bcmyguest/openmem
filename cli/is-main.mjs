import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * True when this module is the process entrypoint. Compares realpaths so npm
 * `.bin/*` symlinks into `node_modules/<pkg>/cli/*.mjs` still count as main.
 *
 * @param {string} metaUrl import.meta.url of the caller
 */
export function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(metaUrl));
  } catch {
    return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(metaUrl));
  }
}
