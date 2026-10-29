#!/usr/bin/env node
// Hindsight wizard, backend "meridian" (Claude subscription through a Meridian proxy the
// user already runs). A stub HTTP server plays Meridian; every case gets a disposable HOME.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHelpers } from "../../wizard/lib/provider-wizard/helpers.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hindsight = await import(pathToFileURL(path.join(root, "providers/hindsight/wizard.mjs")).href);
const { validateHindsight } = await import(
  pathToFileURL(path.join(root, "providers/hindsight/lib/validate.mjs")).href
);

const KEY = "sk-meridian-test-0123456789abcdef";
const ENV_KEYS = [
  "PM_BACKEND",
  "PM_DEFAULT_MODEL",
  "PM_REFLECT_MODEL",
  "MEMORY_API_BASE",
  "MERIDIAN_BASE",
  "MERIDIAN_API_KEY",
  "MERIDIAN_HOST",
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let fails = 0;
function check(desc, ok) {
  if (ok) console.log(`ok    ${desc}`);
  else {
    console.log(`FAIL  ${desc}`);
    fails++;
  }
}

/**
 * Stub Meridian on 127.0.0.1 only. `state.models` is the /v1/models list; with
 * `state.requireKey`, /v1/models answers 401 unless x-api-key matches.
 */
function startStub(state) {
  const server = http.createServer((req, res) => {
    state.requests.push({ url: req.url, key: req.headers["x-api-key"] || "" });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/health") return res.end('{"status":"healthy"}');
    if (req.url === "/v1/models") {
      if (state.requireKey && req.headers["x-api-key"] !== KEY) {
        res.statusCode = 401;
        return res.end('{"error":"unauthorized"}');
      }
      return res.end(JSON.stringify({ object: "list", data: state.models.map((id) => ({ id })) }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/** A port with nothing listening. */
function closedPort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = /** @type {import("node:net").AddressInfo} */ (s.address());
      s.close(() => resolve(port));
    });
  });
}

function resetEnv(extra = {}) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, extra);
}

/** Stubbed helpers: no exits, no commands. `answers` maps a prompt substring to a reply. */
function stubHelpers({ answers = {} } = {}) {
  const calls = { saved: [], pm: [], info: [], warn: [], ok: [], asked: [] };
  const h = createHelpers({
    step: () => {},
    info: (m) => calls.info.push(m),
    ok: (m) => calls.ok.push(m),
    warn: (m) => calls.warn.push(m),
    die: (m) => {
      throw new Error(`die: ${m}`);
    },
    ask: async (_ctx, prompt, def) => {
      calls.asked.push(prompt);
      const hit = Object.keys(answers).find((k) => prompt.includes(k));
      return hit ? answers[hit] : def;
    },
    confirm: async (_ctx, _prompt, def) => def === "y",
    act: async () => {},
    commandExists: () => true,
    saveWizardConf: (_ctx, extra, opts) => {
      calls.saved.push(extra);
      calls.pm.push(opts?.pmSections);
    },
  });
  return { h, calls };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pm-meridian-"));
function freshCtx(name, extra = {}) {
  const home = path.join(tmp, name);
  const hs = path.join(home, ".config/hindsight");
  fs.mkdirSync(hs, { recursive: true });
  return {
    home,
    hsDir: hs,
    repoRoot: root,
    wizardConf: path.join(hs, "wizard.conf"),
    litellmOverride: path.join(hs, "litellm.yaml"),
    litellmEnv: path.join(hs, "litellm.env"),
    yes: true,
    dry: false,
    dockerBridgeIp: "127.0.0.1",
    ...extra,
  };
}

const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
const mode = (f) => fs.statSync(f).mode & 0o777;

const stub = { models: ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5"], requireKey: true, requests: [] };
const server = await startStub(stub);
const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
const base = `http://127.0.0.1:${port}`;
const containerBase = `http://host.docker.internal:${port}`;

try {
  // --yes with the key in the environment: route file from the guide, key in litellm.env.
  resetEnv({ PM_BACKEND: "meridian", MERIDIAN_BASE: base, MERIDIAN_API_KEY: KEY });
  {
    stub.requests = [];
    const ctx = freshCtx("yes");
    const { h, calls } = stubHelpers();
    await hindsight.configureModelRouting(ctx, h);
    const yaml = read(ctx.litellmOverride);
    const env = read(ctx.litellmEnv);
    check("--yes: backend meridian", ctx.backend === "meridian");
    check("--yes: retain model from /v1/models", ctx.model === "claude-haiku-5-5");
    check("--yes: reflect model from /v1/models", ctx.reflectModel === "claude-sonnet-5-5");
    check("--yes: container api_base uses host.docker.internal and the port", ctx.apiBase === containerBase);
    check("--yes: probed /health and /v1/models", stub.requests.some((r) => r.url === "/health") && stub.requests.some((r) => r.url === "/v1/models"));
    check("--yes: /v1/models sent the key as x-api-key", stub.requests.some((r) => r.url === "/v1/models" && r.key === KEY));
    check("--yes: three aliases", ["memory-retain", "memory-reflect", "memory-consolidate"].every((a) => yaml.includes(`- model_name: ${a}\n`)));
    check(
      "--yes: retain and consolidate route to anthropic/claude-haiku-5-5",
      /model_name: memory-retain\n\s+litellm_params:\n\s+model: anthropic\/claude-haiku-5-5\n/.test(yaml) &&
        /model_name: memory-consolidate\n\s+litellm_params:\n\s+model: anthropic\/claude-haiku-5-5\n/.test(yaml),
    );
    check("--yes: reflect routes to anthropic/claude-sonnet-5-5", /model_name: memory-reflect\n\s+litellm_params:\n\s+model: anthropic\/claude-sonnet-5-5\n/.test(yaml));
    check("--yes: api_base without /v1 on every alias", yaml.split(`api_base: ${containerBase}\n`).length === 4);
    check("--yes: api_key references os.environ/MERIDIAN_API_KEY", yaml.split("api_key: os.environ/MERIDIAN_API_KEY\n").length === 4);
    check("--yes: reasoning_effort dropped on every alias", yaml.split('additional_drop_params: ["reasoning_effort"]').length === 4);
    check("--yes: max_tokens and timeout from the guide", yaml.includes("max_tokens: 4096") && yaml.includes("timeout: 300"));
    check("--yes: no llama.cpp thinking flag", !/enable_thinking|chat_template_kwargs|think:/.test(yaml));
    check("--yes: master key from os.environ", yaml.includes("master_key: os.environ/LITELLM_MASTER_KEY"));
    check("--yes: key is not in the YAML", !yaml.includes(KEY));
    check("--yes: key is in litellm.env", env.split("\n").includes(`MERIDIAN_API_KEY=${KEY}`));
    check("--yes: litellm.env created with a master key", /^LITELLM_MASTER_KEY=sk-[0-9a-f]+$/m.test(env));
    check("--yes: litellm.env mode 600", mode(ctx.litellmEnv) === 0o600);
    check("--yes: key value never printed", ![...calls.info, ...calls.ok, ...calls.warn].some((m) => m.includes(KEY)));
    check("--yes: loopback-only check passed on the bridge address", calls.ok.some((m) => m.includes("Docker bridge address 127.0.0.1")));
    check("--yes: no exposure warning when a key is set", !calls.warn.some((m) => m.includes("No MERIDIAN_API_KEY")));
    check("--yes: says the wizard does not start Meridian", calls.info.some((m) => m.includes("does not install or start Meridian")));
    const saved = calls.saved[0] || {};
    check(
      "--yes: wizard.conf records the meridian backend",
      saved.MEMORY_BACKEND === "meridian" &&
        saved.MEMORY_MODEL === "claude-haiku-5-5" &&
        saved.MEMORY_REFLECT_MODEL === "claude-sonnet-5-5" &&
        saved.MEMORY_API_BASE === containerBase &&
        saved.MEMORY_MERIDIAN_URL === base,
    );
    check("--yes: wizard.conf has no key", !Object.values(saved).some((v) => String(v).includes(KEY)));
    const pm = calls.pm[0] || {};
    check("--yes: config.toml [model] backend = meridian", pm.model?.backend === "meridian");
    check("--yes: config.toml [model.meridian] host", pm.model?.meridian?.host === base);
    check("--yes: stack setup runs the lemond profile with the override", hindsight.stackEnv(ctx).env.MEMORY_BACKEND === "lemond");

    ctx.hindsightUrl = "http://127.0.0.1:8888";
    ctx.portCp = "9999";
    const sum = hindsight.summary(ctx);
    check("summary: model line names meridian", sum.running.some((l) => /model\s+meridian, claude-haiku-5-5/.test(l)));
    check("summary: reflect model line", sum.running.some((l) => /reflect model\s+claude-sonnet-5-5/.test(l)));
    check("summary: Meridian line with host URL and container URL", sum.running.some((l) => l.includes(base) && l.includes(containerBase)));
    check("summary: override listed as config file", sum.configFiles.some((l) => l.includes(ctx.litellmOverride) && l.includes("model routes")));
    check("summary: litellm.env listed for MERIDIAN_API_KEY", sum.configFiles.some((l) => l.includes(ctx.litellmEnv) && l.includes("MERIDIAN_API_KEY")));
    check(
      "summary: consumer terms line",
      sum.notes.some((l) => l.includes("Consumer Terms") && l.includes("https://www.anthropic.com/legal/consumer-terms")),
    );

    // Validation sees the route and key; wizard.conf written by hand as the real helper would.
    fs.writeFileSync(ctx.wizardConf, "MEMORY_PROVIDER=hindsight\nMEMORY_BACKEND=meridian\nMEMORY_MODEL=claude-haiku-5-5\n");
    const vctx = { ...ctx, validationErrors: [], validationChecks: [] };
    validateHindsight(vctx, h);
    check("validate: no meridian errors with route and key", !vctx.validationErrors.some((e) => e.startsWith("meridian backend") || e.includes("MERIDIAN_API_KEY")));
    check("validate: meridian check recorded", vctx.validationChecks.includes("Meridian route and key"));
    fs.rmSync(ctx.litellmOverride);
    const vctx2 = { ...ctx, validationErrors: [], validationChecks: [] };
    validateHindsight(vctx2, h);
    check("validate: missing override is an error", vctx2.validationErrors.includes("meridian backend without litellm.yaml override"));
  }

  // Rerun over an existing override and litellm.env: backup, master key kept, key replaced.
  resetEnv({ PM_BACKEND: "meridian", MERIDIAN_BASE: base, MERIDIAN_API_KEY: KEY });
  {
    const ctx = freshCtx("backup");
    fs.writeFileSync(ctx.litellmOverride, "# old lemond override\nmodel_list: []\n");
    fs.writeFileSync(ctx.litellmEnv, "LITELLM_MASTER_KEY=sk-existing\nMERIDIAN_API_KEY=old-key\n", { mode: 0o644 });
    const { h } = stubHelpers();
    await hindsight.configureModelRouting(ctx, h);
    const backups = fs.readdirSync(ctx.hsDir).filter((f) => f.startsWith("litellm.yaml.bak-"));
    check("backup: one .bak copy of the old override", backups.length === 1);
    check("backup: .bak holds the old content", read(path.join(ctx.hsDir, backups[0] || "x")).includes("# old lemond override"));
    check("backup: new override is the Meridian route", read(ctx.litellmOverride).includes("anthropic/claude-haiku-5-5"));
    const env = read(ctx.litellmEnv);
    check("backup: master key kept", env.includes("LITELLM_MASTER_KEY=sk-existing\n"));
    check("backup: key replaced in place, once", env.split("MERIDIAN_API_KEY=").length === 2 && env.includes(`MERIDIAN_API_KEY=${KEY}\n`));
    check("backup: litellm.env tightened to 600", mode(ctx.litellmEnv) === 0o600);
  }

  // Key from Meridian's own env file (the guide's ~/.config/meridian/meridian.env).
  resetEnv({ PM_BACKEND: "meridian", MERIDIAN_BASE: base });
  {
    stub.requests = [];
    const ctx = freshCtx("meridian-env");
    fs.mkdirSync(path.join(ctx.home, ".config/meridian"), { recursive: true });
    fs.writeFileSync(path.join(ctx.home, ".config/meridian/meridian.env"), `MERIDIAN_HOST=0.0.0.0\nMERIDIAN_API_KEY=${KEY}\n`);
    const { h } = stubHelpers();
    await hindsight.configureModelRouting(ctx, h);
    check("meridian.env: key used for the probe", stub.requests.some((r) => r.url === "/v1/models" && r.key === KEY));
    check("meridian.env: key copied to litellm.env", read(ctx.litellmEnv).includes(`MERIDIAN_API_KEY=${KEY}\n`));
  }

  // Models picked from /v1/models when the guide's defaults are not listed.
  resetEnv({ PM_BACKEND: "meridian", MERIDIAN_BASE: base, MERIDIAN_API_KEY: KEY, PM_DEFAULT_MODEL: "Gemma-4-E2B-it-GGUF" });
  {
    stub.models = ["claude-haiku-4-5", "claude-sonnet-4-6"];
    const ctx = freshCtx("models");
    const { h } = stubHelpers();
    await hindsight.configureModelRouting(ctx, h);
    check("models: leftover non-Claude PM_DEFAULT_MODEL ignored; haiku family picked", ctx.model === "claude-haiku-4-5");
    check("models: sonnet family picked for reflect", ctx.reflectModel === "claude-sonnet-4-6");
    stub.models = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5"];
  }

  // Loopback-only Meridian: answers on 127.0.0.1 but not on the bridge address.
  resetEnv({ PM_BACKEND: "meridian", MERIDIAN_BASE: base, MERIDIAN_API_KEY: KEY });
  {
    const ctx = freshCtx("loopback", { dockerBridgeIp: "127.0.0.2" });
    const { h, calls } = stubHelpers();
    await hindsight.configureModelRouting(ctx, h);
    check(
      "loopback-only: warns the container cannot reach it and names MERIDIAN_HOST=0.0.0.0",
      calls.warn.some((m) => m.includes("binds 127.0.0.1 only") && m.includes("MERIDIAN_HOST=0.0.0.0")),
    );
  }

  // No Docker bridge known: state the requirement instead.
  resetEnv({ PM_BACKEND: "meridian", MERIDIAN_BASE: base, MERIDIAN_API_KEY: KEY });
  {
    const ctx = freshCtx("no-bridge", { dockerBridgeIp: "" });
    const { h, calls } = stubHelpers();
    await hindsight.configureModelRouting(ctx, h);
    check("no bridge: states the MERIDIAN_HOST=0.0.0.0 requirement", calls.info.some((m) => m.includes("MERIDIAN_HOST=0.0.0.0")));
  }

  // MERIDIAN_HOST=127.0.0.1 declared in meridian.env, no bridge: warn.
  resetEnv({ PM_BACKEND: "meridian", MERIDIAN_BASE: base, MERIDIAN_API_KEY: KEY });
  {
    const ctx = freshCtx("declared-loopback", { dockerBridgeIp: "" });
    fs.mkdirSync(path.join(ctx.home, ".config/meridian"), { recursive: true });
    fs.writeFileSync(path.join(ctx.home, ".config/meridian/meridian.env"), "MERIDIAN_HOST=127.0.0.1\n");
    const { h, calls } = stubHelpers();
    await hindsight.configureModelRouting(ctx, h);
    check("declared loopback: warns about MERIDIAN_HOST", calls.warn.some((m) => m.includes("MERIDIAN_HOST is 127.0.0.1")));
  }

  // Key rejected: /v1/models answers 401; no key means a placeholder and an exposure warning.
  resetEnv({ PM_BACKEND: "meridian", MERIDIAN_BASE: base });
  {
    const ctx = freshCtx("no-key");
    const { h, calls } = stubHelpers();
    await hindsight.configureModelRouting(ctx, h);
    check("401: warns that Meridian rejected the request", calls.warn.some((m) => m.includes("rejected") && m.includes("401")));
    check("401: falls back to the guide's default models", ctx.model === "claude-haiku-5-5" && ctx.reflectModel === "claude-sonnet-5-5");
    check("no key: exposure warning", calls.warn.some((m) => m.includes("No MERIDIAN_API_KEY")));
    check("no key: placeholder in litellm.env, YAML still references the env var", read(ctx.litellmEnv).includes("MERIDIAN_API_KEY=placeholder\n") && read(ctx.litellmOverride).includes("os.environ/MERIDIAN_API_KEY"));
  }

  // Unreachable Meridian: clear message, guide defaults, route still written.
  const deadPort = await closedPort();
  resetEnv({ PM_BACKEND: "meridian", MERIDIAN_BASE: `http://127.0.0.1:${deadPort}`, MERIDIAN_API_KEY: KEY });
  {
    const ctx = freshCtx("unreachable");
    const { h, calls } = stubHelpers();
    await hindsight.configureModelRouting(ctx, h);
    check(
      "unreachable: clear warning with the URL and the guide",
      calls.warn.some((m) => m.includes(`not answering on http://127.0.0.1:${deadPort}`) && m.includes("docs/meridian-litellm.md")),
    );
    check("unreachable: no bridge claim", !calls.ok.some((m) => m.includes("bridge")) && !calls.warn.some((m) => m.includes("binds 127.0.0.1 only")));
    check("unreachable: guide defaults", ctx.model === "claude-haiku-5-5" && ctx.reflectModel === "claude-sonnet-5-5");
    check("unreachable: route written for the configured port", read(ctx.litellmOverride).includes(`api_base: http://host.docker.internal:${deadPort}\n`));
  }

  // Dry run: plan printed, nothing written, existing files untouched.
  resetEnv({ PM_BACKEND: "meridian", MERIDIAN_BASE: base, MERIDIAN_API_KEY: KEY });
  {
    const ctx = freshCtx("dry", { dry: true });
    fs.writeFileSync(ctx.litellmOverride, "# keep me\n");
    const { h, calls } = stubHelpers();
    await hindsight.configureModelRouting(ctx, h);
    check("dry run: override untouched, no backup", read(ctx.litellmOverride) === "# keep me\n" && fs.readdirSync(ctx.hsDir).every((f) => !f.includes(".bak-")));
    check("dry run: no litellm.env", !fs.existsSync(ctx.litellmEnv));
    check("dry run: no wizard.conf save", calls.saved.length === 0);
    check("dry run: route plan printed", calls.info.some((m) => m.startsWith("[dry-run] write ") && m.includes("anthropic/claude-haiku-5-5") && m.includes("backs up")));
    check("dry run: key plan printed without the value", calls.info.some((m) => m.startsWith("[dry-run] set MERIDIAN_API_KEY")) && !calls.info.some((m) => m.includes(KEY)));
    check("dry run: backend record planned", calls.info.some((m) => m.startsWith("[dry-run] record backend meridian")));
  }

  // Interactive menu: "4" picks Meridian; answers override the defaults.
  resetEnv();
  {
    const ctx = freshCtx("interactive", { yes: false });
    const { h, calls } = stubHelpers({
      answers: {
        "Model backend": "4",
        "Meridian URL": `${base}/v1/`,
        MERIDIAN_API_KEY: KEY,
        "retain / consolidate": "claude-opus-5",
      },
    });
    await hindsight.configureModelRouting(ctx, h);
    check("interactive: menu offers option 4", calls.info.some((m) => m.includes("4) Claude subscription (Meridian)")));
    check("interactive: /v1 and trailing slash stripped from the URL", ctx.meridianBase === base);
    check("interactive: typed retain model used", ctx.model === "claude-opus-5" && read(ctx.litellmOverride).includes("anthropic/claude-opus-5"));
    check("interactive: typed key stored in litellm.env only", read(ctx.litellmEnv).includes(`MERIDIAN_API_KEY=${KEY}\n`) && !read(ctx.litellmOverride).includes(KEY));
  }

  // Clack handoff (skipBackendStep): no probing, values from the environment.
  resetEnv({
    PM_BACKEND: "meridian",
    PM_DEFAULT_MODEL: "claude-haiku-5-5",
    PM_REFLECT_MODEL: "claude-sonnet-5-5",
    MEMORY_API_BASE: containerBase,
    MERIDIAN_BASE: base,
    MERIDIAN_API_KEY: KEY,
  });
  {
    stub.requests = [];
    const ctx = freshCtx("skip", { skipBackendStep: true });
    const { h, calls } = stubHelpers();
    await hindsight.configureModelRouting(ctx, h);
    check("skipBackendStep: no probe", stub.requests.length === 0);
    check("skipBackendStep: route written", read(ctx.litellmOverride).includes(`api_base: ${containerBase}\n`));
    check("skipBackendStep: key in litellm.env", read(ctx.litellmEnv).includes(`MERIDIAN_API_KEY=${KEY}\n`));
    check("skipBackendStep: conf records the Meridian URL", calls.saved[0]?.MEMORY_MERIDIAN_URL === base);
  }
} finally {
  server.close();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (fails) {
  console.log(`${fails} meridian wizard test(s) failed`);
  process.exit(1);
}
console.log("all meridian wizard tests passed");
