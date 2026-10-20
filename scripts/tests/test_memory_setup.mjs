#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateMemorySetup } from "../../wizard/lib/validate-setup.mjs";
import { resolveProvider } from "../../wizard/lib/providers/registry.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pm-setup-val-"));
let fails = 0;
function check(desc, ok) {
  if (ok) console.log(`ok    ${desc}`);
  else {
    console.log(`FAIL  ${desc}`);
    fails++;
  }
}

const home = path.join(tmp, "home");
const hs = path.join(home, ".config/hindsight");
fs.mkdirSync(hs, { recursive: true });
const repo = path.join(tmp, "repo");
fs.mkdirSync(repo, { recursive: true });

const ctx = {
  repoRoot: repo,
  home,
  hsDir: hs,
  envFile: path.join(hs, "hindsight.env"),
  litellmEnv: path.join(hs, "litellm.env"),
  litellmOverride: path.join(hs, "litellm.yaml"),
  indexFile: path.join(hs, "index.yml"),
  wizardConf: path.join(hs, "wizard.conf"),
  lemondDefaultModel: "Gemma-4-E2B-it-GGUF",
  ollamaDefaultModel: "gemma4:e2b",
  memoryProvider: resolveProvider("hindsight"),
  portApi: "8888",
  hindsightUrl: "http://127.0.0.1:8888",
};

let r = validateMemorySetup(ctx);
check("empty home fails validation", !r.ok);

fs.writeFileSync(
  ctx.wizardConf,
  "MEMORY_PROVIDER=hindsight\nMEMORY_BACKEND=lemond\nMEMORY_MODEL=Gemma-4-E2B-it-GGUF\n",
);
fs.writeFileSync(ctx.envFile, "HINDSIGHT_API_LLM_BASE_URL=http://litellm:4000/v1\nHINDSIGHT_API_LLM_API_KEY=sk-test\n", {
  mode: 0o600,
});
fs.writeFileSync(ctx.litellmEnv, "LITELLM_MASTER_KEY=sk-test\n", { mode: 0o600 });
fs.writeFileSync(ctx.indexFile, "roots:\n  - path: \"~\"\n    depth: 1\n");
fs.writeFileSync(path.join(repo, ".env"), "HOST_UID=1000\nHOST_GID=1000\nLITELLM_CONFIG=/x\nHINDSIGHT_PORT=8888\n");
fs.mkdirSync(path.join(home, ".cache/hindsight-project-index"), { recursive: true });

r = validateMemorySetup(ctx);
check("complete hindsight layout passes", r.ok);
if (!r.ok) for (const e of r.errors) console.log(`      ${e}`);

fs.rmSync(tmp, { recursive: true, force: true });

if (fails) {
  console.log(`${fails} memory setup validation test(s) failed`);
  process.exit(1);
}
console.log("all memory setup validation tests passed");
