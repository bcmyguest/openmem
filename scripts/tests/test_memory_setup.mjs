#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateMemorySetup } from "../../wizard/lib/validate-setup.mjs";
import { resolveProvider } from "../../wizard/lib/providers/registry.mjs";
import { createHelpers } from "../../wizard/lib/provider-wizard/helpers.mjs";
import { extendValidation } from "../../providers/hindsight/wizard.mjs";
import { ensureState } from "../../providers/hindsight/lib/state.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
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
  indexFile: path.join(hs, "index.yml"),
  wizardConf: path.join(hs, "wizard.conf"),
  memoryProvider: resolveProvider("hindsight"),
};
ensureState(ctx);

/** Shared checks plus the provider's extendValidation hook, as the wizard runs them. */
async function validate(c, hook = extendValidation) {
  c.validationErrors = [];
  c.validationChecks = [];
  if (hook) await hook(c, createHelpers());
  const r = validateMemorySetup(c);
  r.errors.push(...c.validationErrors);
  r.checks.push(...c.validationChecks);
  r.ok = r.errors.length === 0;
  return r;
}

let r = await validate(ctx);
check("empty home fails validation", !r.ok);
check("empty home: hindsight.env reported by the hindsight hook", r.errors.some((e) => e.includes("hindsight.env")));

// The shared validator alone knows nothing about hindsight.env or litellm.env.
const generic = validateMemorySetup(ctx);
check(
  "generic validation names no hindsight/litellm files",
  !generic.errors.concat(generic.checks).some((m) => /hindsight\.env|litellm|HINDSIGHT_|MEMORY_BACKEND|MEMORY_MODEL/.test(m)),
);

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

r = await validate(ctx);
check("complete hindsight layout passes", r.ok);
if (!r.ok) for (const e of r.errors) console.log(`      ${e}`);

fs.writeFileSync(path.join(repo, ".env"), "HOST_UID=1000\nHOST_GID=1000\n");
r = await validate(ctx);
check("hindsight hook requires LITELLM_CONFIG and HINDSIGHT_PORT in the stack .env", r.errors.some((e) => e.includes("LITELLM_CONFIG")) && r.errors.some((e) => e.includes("HINDSIGHT_PORT")));
r = await validate(ctx, null);
check("generic validation needs only HOST_UID and HOST_GID in the stack .env", r.ok);
fs.writeFileSync(path.join(repo, ".env"), "HOST_UID=1000\nHOST_GID=1000\nLITELLM_CONFIG=/x\nHINDSIGHT_PORT=8888\n");

fs.writeFileSync(ctx.envFile, "HINDSIGHT_API_LLM_BASE_URL=http://host.docker.internal:13305/v1\nHINDSIGHT_API_LLM_API_KEY=sk-test\n", { mode: 0o600 });
r = await validate(ctx);
check("hindsight.env not wired to the LiteLLM proxy fails", r.errors.some((e) => e.includes("not wired to LiteLLM")));
fs.writeFileSync(ctx.envFile, "HINDSIGHT_API_LLM_BASE_URL=http://litellm:4000/v1\nHINDSIGHT_API_LLM_API_KEY=sk-test\n", { mode: 0o600 });

fs.writeFileSync(ctx.wizardConf, "MEMORY_PROVIDER=hindsight\nMEMORY_BACKEND=lemond\nMEMORY_MODEL=Other-GGUF\n");
r = await validate(ctx);
check("custom model without an override fails (hindsight hook)", r.errors.some((e) => e.includes("custom model without litellm.yaml override")));
fs.writeFileSync(ctx.wizardConf, "MEMORY_PROVIDER=hindsight\nMEMORY_BACKEND=lemond\nMEMORY_MODEL=Gemma-4-E2B-it-GGUF\n");

fs.writeFileSync(ctx.wizardConf, "MEMORY_PROVIDER=hindsight\n");
r = await validate(ctx);
check("hindsight requires MEMORY_BACKEND and MEMORY_MODEL", r.errors.some((e) => e.includes("MEMORY_BACKEND")) && r.errors.some((e) => e.includes("MEMORY_MODEL")));

// A provider with no model backend: shared checks only; no MEMORY_BACKEND/MEMORY_MODEL, no hindsight files.
process.env.PM_PROVIDERS_DIR = path.join(here, "fixtures/providers");
{
  const bare = path.join(tmp, "bare-home");
  const bareHs = path.join(bare, ".config/hindsight");
  fs.mkdirSync(bareHs, { recursive: true });
  const bareRepo = path.join(tmp, "bare-repo");
  fs.mkdirSync(bareRepo, { recursive: true });
  const bctx = {
    repoRoot: bareRepo,
    home: bare,
    hsDir: bareHs,
    indexFile: path.join(bareHs, "index.yml"),
    wizardConf: path.join(bareHs, "wizard.conf"),
    memoryProvider: resolveProvider("nohooks"),
  };
  fs.writeFileSync(bctx.wizardConf, "MEMORY_PROVIDER=nohooks\n");
  fs.writeFileSync(bctx.indexFile, "roots: []\n");
  fs.writeFileSync(path.join(bareRepo, ".env"), "HOST_UID=1000\nHOST_GID=1000\n");
  fs.mkdirSync(path.join(bare, ".cache/hindsight-project-index"), { recursive: true });
  r = await validate(bctx, null);
  check("no-model provider passes without MEMORY_BACKEND/MEMORY_MODEL/hindsight.env/litellm.env", r.ok);
  if (!r.ok) for (const e of r.errors) console.log(`      ${e}`);
  fs.writeFileSync(bctx.wizardConf, "MEMORY_PROVIDER=hindsight\n");
  r = await validate(bctx, null);
  check("wizard.conf provider mismatch fails", r.errors.some((e) => e.includes("does not match active nohooks")));
}
delete process.env.PM_PROVIDERS_DIR;

fs.rmSync(tmp, { recursive: true, force: true });

if (fails) {
  console.log(`${fails} memory setup validation test(s) failed`);
  process.exit(1);
}
console.log("all memory setup validation tests passed");
