#!/usr/bin/env node
/** Runs the context-proxy Python unit tests (proxy/tests) so `npm test` covers them. */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const r = spawnSync("python3", ["-m", "unittest", "discover", "-s", "proxy/tests"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
});
if (r.error) {
  console.error(`context proxy tests: cannot run python3: ${r.error.message}`);
  process.exit(1);
}
if (r.status !== 0) {
  console.error("context proxy tests failed");
  process.exit(r.status ?? 1);
}
console.log("all context proxy tests passed");
