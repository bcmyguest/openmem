import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function expandHome(p, home = process.env.HOME || os.homedir()) {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

export function envValue(filePath, key) {
  if (!fs.existsSync(filePath)) return "";
  const prefix = `${key}=`;
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    if (line.startsWith(prefix)) return line.slice(prefix.length);
  }
  return "";
}

export function ensureHsDir(ctx) {
  if (ctx.dry) return;
  fs.mkdirSync(ctx.hsDir, { recursive: true, mode: 0o700 });
}

export function realpathSafe(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Mount point for the shared indexer's state. The directory name predates provider
 * plugins and stays fixed so existing state keeps working.
 */
export function indexerStateDir(ctx) {
  return path.join(ctx.home, ".cache", "hindsight-project-index");
}
