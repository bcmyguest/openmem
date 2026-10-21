#!/usr/bin/env node
/** Run indexer/feed_sync.py (RSS + OpenAlex → markdown cache). */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(PKG_ROOT, "indexer", "feed_sync.py");

const r = spawnSync("python3", [script, ...process.argv.slice(2)], { stdio: "inherit", cwd: PKG_ROOT });
process.exit(r.status ?? 1);
