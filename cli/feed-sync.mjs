#!/usr/bin/env node
/** Run indexer/feed_sync.py (RSS + OpenAlex → markdown cache). */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(PKG_ROOT, "indexer", "feed_sync.py");

export function pythonCandidates(platform = process.platform, env = process.env) {
  if (env.PYTHON) return [[env.PYTHON, []]];
  return platform === "win32" ? [["py", ["-3"]], ["python", []]] : [["python3", []], ["python", []]];
}

if (isMainModule(import.meta.url)) {
  let missing = true;
  for (const [command, prefix] of pythonCandidates()) {
    const result = spawnSync(command, [...prefix, script, ...process.argv.slice(2)], { stdio: "inherit", cwd: PKG_ROOT });
    if (result.error?.code === "ENOENT") continue;
    missing = false;
    if (result.error) console.error(`feed-sync: ${result.error.message}`);
    process.exit(result.status ?? 1);
  }
  if (missing) console.error("feed-sync: Python 3 not found; install Python 3 with PyYAML or set PYTHON to its executable");
  process.exit(1);
}
