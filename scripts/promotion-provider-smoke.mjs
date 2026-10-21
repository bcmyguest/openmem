#!/usr/bin/env node
/**
 * Promotion bar for experimental → supported: run contract tests; optional live Docker stacks.
 * CI runs the Node tests only. Maintainers: MEM0_PROMOTION=1 COGNEE_PROMOTION=1 with stacks up.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tests = [
  "scripts/tests/test_memory_facade.mjs",
  "scripts/tests/test_memory_portability.mjs",
  "scripts/tests/test_compose_profiles.mjs",
  "scripts/tests/test_coding_agents.mjs",
  "scripts/tests/test_wiring_report.mjs",
  "scripts/tests/test_install_coding_agent.mjs",
];

let failed = 0;
for (const t of tests) {
  const r = spawnSync(process.execPath, [path.join(root, t)], { stdio: "inherit" });
  if (r.status !== 0) failed++;
}

if (process.env.MEM0_PROMOTION === "1") {
  console.log("MEM0_PROMOTION=1: run live mem0 stack + wizard smoke manually (see providers/mem0/OPERATOR.md)");
}
if (process.env.COGNEE_PROMOTION === "1") {
  console.log("COGNEE_PROMOTION=1: run live Cognee cognify+search manually (see docs/cognee.md)");
}

process.exit(failed ? 1 : 0);
