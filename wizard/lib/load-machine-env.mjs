import fs from "node:fs";
import path from "node:path";

/** @param {string} repoRoot */
export function loadMachineEnv(repoRoot) {
  const file = path.join(repoRoot, "config", "machine.env");
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}
