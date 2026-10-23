import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const accessConfigPath = (home) => path.join(home, ".config", "personal-memory", "coding-agent.json");

/** Read policy config. A missing file keeps the historical device-wide default; all other read/parse errors deny. */
export function readAccessConfig(home) {
  try {
    const config = JSON.parse(fs.readFileSync(accessConfigPath(home), "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) return null;
    if ("disabled" in config && typeof config.disabled !== "boolean") return null;
    if ("optInOnly" in config && typeof config.optInOnly !== "boolean") return null;
    if ("optInPaths" in config && (!Array.isArray(config.optInPaths)
      || config.optInPaths.some((p) => typeof p !== "string" || !p.trim() || !path.isAbsolute(p)))) return null;
    if ("mapPathToBank" in config && (!config.mapPathToBank || typeof config.mapPathToBank !== "object"
      || Array.isArray(config.mapPathToBank)
      || Object.entries(config.mapPathToBank).some(([prefix, bank]) => !prefix.trim() || !path.isAbsolute(prefix)
        || typeof bank !== "string" || !bank.trim()))) return null;
    return config;
  } catch (error) {
    return error?.code === "ENOENT" ? {} : null;
  }
}

export function accessAllowed(cwd, config) {
  if (!config || typeof cwd !== "string" || !cwd.trim() || !path.isAbsolute(cwd) || config.disabled === true) return false;
  if (config.optInOnly !== true) return true;
  const dir = path.resolve(cwd);
  return (config.optInPaths || []).some((configured) => {
    const allowed = path.resolve(configured);
    return dir === allowed || dir.startsWith(`${allowed}${path.sep}`);
  });
}

export function currentHome() {
  return process.env.HOME || os.homedir();
}
