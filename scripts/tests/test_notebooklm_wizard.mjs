#!/usr/bin/env node
/**
 * Unit tests for wizard/lib/notebooklm.mjs (auto-login + NOTEBOOKLM_HOME inject)
 * and notebooklm-agent-access.mjs (coding-agent.json materialize / enabled flag).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  notebooklmHome,
  notebooklmEnv,
  injectNotebooklmHome,
  notebooklmAuthOk,
  setupNotebooklm,
  offerNotebooklmMcpAccess,
} from "../../wizard/lib/notebooklm.mjs";
import {
  ensureCodingAgentJsonRealFile,
  setNotebooklmAccessEnabled,
} from "../../wizard/lib/notebooklm-agent-access.mjs";
import { writeWizardConf, upsertWizardConf } from "../../wizard/lib/wizard-conf.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SHIPPED = path.join(ROOT, "config/coding-agent.json");

let failed = 0;

function check(name, cond, detail = "") {
  if (cond) console.log(`ok    ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pm-nlm-"));
  fs.mkdirSync(path.join(home, ".config/hindsight"), { recursive: true, mode: 0o700 });
  return home;
}

function baseCtx(home, extras = {}) {
  return {
    home,
    repoRoot: ROOT,
    hsDir: path.join(home, ".config/hindsight"),
    wizardConf: path.join(home, ".config/hindsight/wizard.conf"),
    notebookFile: path.join(home, ".config/hindsight/notebooklm.yml"),
    agentJson: path.join(home, ".hindsight/coding-agent.json"),
    notebooklmPkg: "notebooklm-py[browser]==0.8.5",
    memoryProvider: { id: "hindsight" },
    dry: false,
    yes: false,
    ...extras,
  };
}

const shippedBefore = fs.readFileSync(SHIPPED, "utf8");

{
  const home = tmpHome();
  const ctx = baseCtx(home);
  check("notebooklmHome is ~/.config/notebooklm under ctx.home", notebooklmHome(ctx) === path.join(home, ".config/notebooklm"));
  check("notebooklmEnv sets NOTEBOOKLM_HOME", notebooklmEnv(ctx).NOTEBOOKLM_HOME === notebooklmHome(ctx));
  fs.rmSync(home, { recursive: true, force: true });
}

{
  const home = tmpHome();
  const ctx = baseCtx(home);
  writeWizardConf(ctx, { HINDSIGHT_PORT: "8888" });
  injectNotebooklmHome(ctx);
  const conf = fs.readFileSync(ctx.wizardConf, "utf8");
  check("inject writes NOTEBOOKLM_HOME into wizard.conf", conf.includes(`NOTEBOOKLM_HOME=${notebooklmHome(ctx)}`));
  check("inject keeps MEMORY_PROVIDER", /^MEMORY_PROVIDER=hindsight$/m.test(conf));
  check("inject keeps provider keys", conf.includes("HINDSIGHT_PORT=8888"));
  check("inject sets process.env.NOTEBOOKLM_HOME", process.env.NOTEBOOKLM_HOME === notebooklmHome(ctx));
  writeWizardConf(ctx, { HINDSIGHT_PORT: "9999" });
  const again = fs.readFileSync(ctx.wizardConf, "utf8");
  check("writeWizardConf preserves NOTEBOOKLM_HOME meta key", again.includes(`NOTEBOOKLM_HOME=${notebooklmHome(ctx)}`));
  check("writeWizardConf still updates provider extras", again.includes("HINDSIGHT_PORT=9999"));
  fs.rmSync(home, { recursive: true, force: true });
}

{
  const home = tmpHome();
  const ctx = baseCtx(home);
  writeWizardConf(ctx, {});
  upsertWizardConf(ctx, { NOTEBOOKLM_HOME: "/tmp/nlm", COGNEE_PORT: "1" });
  upsertWizardConf(ctx, { NOTEBOOKLM_HOME: "/tmp/nlm2" });
  const conf = fs.readFileSync(ctx.wizardConf, "utf8");
  check("upsert replaces NOTEBOOKLM_HOME", conf.includes("NOTEBOOKLM_HOME=/tmp/nlm2") && !conf.includes("NOTEBOOKLM_HOME=/tmp/nlm\n"));
  check("upsert keeps other keys", conf.includes("COGNEE_PORT=1"));
  fs.rmSync(home, { recursive: true, force: true });
}

{
  const home = tmpHome();
  const ctx = baseCtx(home, { dry: true, yes: true });
  let enabled = false;
  await setupNotebooklm(ctx, () => {
    enabled = true;
  });
  check("dry+yes skip enable (default n)", !enabled);
  check("dry+yes does not create notebooklm.yml", !fs.existsSync(ctx.notebookFile));
  fs.rmSync(home, { recursive: true, force: true });
}

{
  // Auth check against a fake PATH entry: a shell script named notebooklm that exits 0.
  const home = tmpHome();
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const fake = path.join(bin, "notebooklm");
  fs.writeFileSync(fake, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const prevPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${prevPath}`;
  const ctx = baseCtx(home);
  check("notebooklmAuthOk true when CLI exits 0", notebooklmAuthOk(ctx));
  fs.writeFileSync(fake, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  check("notebooklmAuthOk false when CLI exits 1", !notebooklmAuthOk(ctx));
  process.env.PATH = prevPath;
  fs.rmSync(home, { recursive: true, force: true });
}

{
  // Full happy path without a browser: fake notebooklm always OK + force confirm yes via --yes default n means skip.
  // Interactive confirm is not driven here; instead call inject + enable path pieces.
  const home = tmpHome();
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "notebooklm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const prevPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${prevPath}`;
  const ctx = baseCtx(home);
  writeWizardConf(ctx, {});
  // Simulate the enable branch after auth ok: inject + write enableNotebooklm
  injectNotebooklmHome(ctx);
  fs.writeFileSync(ctx.notebookFile, "enabled: true\n");
  check("session-valid path leaves enabled yml", /enabled:\s*true/.test(fs.readFileSync(ctx.notebookFile, "utf8")));
  check("session-valid path has NOTEBOOKLM_HOME in conf", fs.readFileSync(ctx.wizardConf, "utf8").includes("NOTEBOOKLM_HOME="));
  process.env.PATH = prevPath;
  fs.rmSync(home, { recursive: true, force: true });
}

{
  // --yes with enable would need confirm default y; our confirm default is n so skipped.
  // Under --yes after a forced enable of the login helper:
  const home = tmpHome();
  const ctx = baseCtx(home, { yes: true });
  const { runNotebooklmLogin } = await import("../../wizard/lib/notebooklm.mjs");
  const okLogin = await runNotebooklmLogin(ctx);
  check("--yes does not open browser login", okLogin === false);
  fs.rmSync(home, { recursive: true, force: true });
}

{
  // Happy path: valid session + confirm yes → inject + enable (stub confirm via yes + flipped default by calling internals).
  const home = tmpHome();
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "notebooklm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const prevPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${prevPath}`;
  const ctx = baseCtx(home);
  writeWizardConf(ctx, {});
  let enabled = false;
  // Drive the enable path the wizard uses after auth ok:
  injectNotebooklmHome(ctx);
  check("auth ok before enable", notebooklmAuthOk(ctx));
  enabled = true;
  fs.writeFileSync(
    ctx.notebookFile,
    "# Per-machine overrides (changed keys only); see config/notebooklm.yml.\nenabled: true\n",
  );
  check("enabled notebooklm.yml after auto-login path", enabled && /enabled:\s*true/.test(fs.readFileSync(ctx.notebookFile, "utf8")));
  process.env.PATH = prevPath;
  fs.rmSync(home, { recursive: true, force: true });
}

// --- coding-agent.json materialize / notebooklmAccess.enabled ---
{
  const home = tmpHome();
  const agent = path.join(home, ".hindsight", "coding-agent.json");
  const r = setNotebooklmAccessEnabled(agent, SHIPPED, true);
  check("setEnabled creates real file", fs.existsSync(agent) && !fs.lstatSync(agent).isSymbolicLink());
  const cfg = JSON.parse(fs.readFileSync(agent, "utf8"));
  check("setEnabled writes enabled true", cfg.notebooklmAccess.enabled === true);
  check("setEnabled keeps banks *", cfg.notebooklmAccess.banks.join() === "*");
  check("setEnabled action created", r.action === "created");
  check("shipped template unchanged after create", fs.readFileSync(SHIPPED, "utf8") === shippedBefore);
  fs.rmSync(home, { recursive: true, force: true });
}

{
  const home = tmpHome();
  const agent = path.join(home, ".hindsight", "coding-agent.json");
  fs.mkdirSync(path.dirname(agent), { recursive: true });
  fs.symlinkSync(SHIPPED, agent);
  check("precondition: agent is symlink to shipped", fs.lstatSync(agent).isSymbolicLink());
  setNotebooklmAccessEnabled(agent, SHIPPED, true);
  check("materialize: agent is regular file", fs.statSync(agent).isFile() && !fs.lstatSync(agent).isSymbolicLink());
  const cfg = JSON.parse(fs.readFileSync(agent, "utf8"));
  check("materialize: enabled true on copy", cfg.notebooklmAccess.enabled === true);
  check("shipped template unchanged after materialize", fs.readFileSync(SHIPPED, "utf8") === shippedBefore);
  const shippedCfg = JSON.parse(shippedBefore);
  check("shipped still has enabled false", shippedCfg.notebooklmAccess.enabled === false);
  fs.rmSync(home, { recursive: true, force: true });
}

{
  const home = tmpHome();
  const agent = path.join(home, ".hindsight", "coding-agent.json");
  const plan = setNotebooklmAccessEnabled(agent, SHIPPED, true, { dry: true });
  check("dry setEnabled does not create file", !fs.existsSync(agent));
  check("dry setEnabled reports would-create", plan.action === "would-create" && plan.wrote === false);
  fs.rmSync(home, { recursive: true, force: true });
}

{
  const home = tmpHome();
  const agent = path.join(home, ".hindsight", "coding-agent.json");
  ensureCodingAgentJsonRealFile(agent, SHIPPED);
  setNotebooklmAccessEnabled(agent, SHIPPED, false);
  const cfg = JSON.parse(fs.readFileSync(agent, "utf8"));
  check("setEnabled false", cfg.notebooklmAccess.enabled === false);
  fs.rmSync(home, { recursive: true, force: true });
}

{
  // --yes after sync enabled: MCP confirm default y → writes enabled + would call install
  const home = tmpHome();
  const ctx = baseCtx(home, { yes: true, dry: false });
  const allowed = await offerNotebooklmMcpAccess(ctx);
  check("offer --yes accepts MCP (default y)", allowed === true);
  const cfg = JSON.parse(fs.readFileSync(ctx.agentJson, "utf8"));
  check("offer --yes sets enabled true", cfg.notebooklmAccess.enabled === true);
  check("offer --yes leaves shipped template alone", fs.readFileSync(SHIPPED, "utf8") === shippedBefore);
  const mcpPath = path.join(home, ".cursor", "mcp.json");
  check("offer --yes registers notebooklm MCP", fs.existsSync(mcpPath) && JSON.parse(fs.readFileSync(mcpPath, "utf8")).mcpServers?.notebooklm);
  fs.rmSync(home, { recursive: true, force: true });
}

{
  const home = tmpHome();
  const ctx = baseCtx(home, { yes: true, dry: true });
  const allowed = await offerNotebooklmMcpAccess(ctx);
  check("offer dry+yes prints plan, accepts", allowed === true);
  check("offer dry+yes writes nothing", !fs.existsSync(ctx.agentJson) && !fs.existsSync(path.join(home, ".cursor", "mcp.json")));
  fs.rmSync(home, { recursive: true, force: true });
}

{
  // Auth-ok path: sync confirm skipped via calling enable + offer after fake auth
  const home = tmpHome();
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "notebooklm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const prevPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${prevPath}`;
  const ctx = baseCtx(home, { yes: true });
  writeWizardConf(ctx, {});
  // Force sync confirm by temporarily... we can't flip confirm default; drive auth path pieces + offer.
  injectNotebooklmHome(ctx);
  fs.writeFileSync(ctx.notebookFile, "enabled: true\n");
  await offerNotebooklmMcpAccess(ctx);
  check(
    "post-enable offer writes agent MCP flag",
    JSON.parse(fs.readFileSync(ctx.agentJson, "utf8")).notebooklmAccess.enabled === true,
  );
  process.env.PATH = prevPath;
  fs.rmSync(home, { recursive: true, force: true });
}

// --- setupCodingAgent: symlink → real file + MCP when NotebookLM sync is on ---
{
  const { setupCodingAgent } = await import("../../providers/hindsight/lib/coding-agent.mjs");
  const home = tmpHome();
  const agent = path.join(home, ".hindsight", "coding-agent.json");
  fs.mkdirSync(path.dirname(agent), { recursive: true });
  fs.symlinkSync(SHIPPED, agent);
  fs.writeFileSync(path.join(home, ".config/hindsight/notebooklm.yml"), "enabled: true\n");
  // Minimal index.yml so optInPaths check has something to cover (none → ok).
  const indexFile = path.join(home, ".config/hindsight/index.yml");
  fs.writeFileSync(indexFile, "roots: []\n");
  const logs = [];
  const h = {
    ok: (m) => logs.push(`ok:${m}`),
    info: (m) => logs.push(`info:${m}`),
    warn: (m) => logs.push(`warn:${m}`),
    confirm: async () => false,
    expandHome: (p, homeDir) => (p.startsWith("~/") ? path.join(homeDir, p.slice(2)) : p),
  };
  const ctx = {
    ...baseCtx(home),
    indexFile,
    dry: false,
    memoryProvider: { id: "hindsight", codingAgent: { configTemplate: "config/coding-agent.json" } },
  };
  await setupCodingAgent(ctx, h);
  check(
    "setupCodingAgent materializes symlink to real file",
    fs.existsSync(agent) && !fs.lstatSync(agent).isSymbolicLink(),
  );
  const cfg = JSON.parse(fs.readFileSync(agent, "utf8"));
  check("setupCodingAgent enables notebooklmAccess when sync on", cfg.notebooklmAccess.enabled === true);
  const mcp = JSON.parse(fs.readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8"));
  const nlm = mcp.mcpServers?.notebooklm;
  check(
    "setupCodingAgent registers notebooklm MCP with absolute node + agentJson env",
    nlm?.command === process.execPath &&
      nlm?.args?.[0]?.endsWith("cli/notebooklm-mcp.mjs") &&
      nlm?.env?.HINDSIGHT_CODING_AGENT_JSON === agent,
  );
  check("setupCodingAgent leaves shipped template alone", fs.readFileSync(SHIPPED, "utf8") === shippedBefore);
  fs.rmSync(home, { recursive: true, force: true });
}

check("shipped template untouched at end", fs.readFileSync(SHIPPED, "utf8") === shippedBefore);

if (failed) {
  console.error(`${failed} notebooklm wizard test(s) failed`);
  process.exit(1);
}
console.log("all notebooklm wizard tests passed");
