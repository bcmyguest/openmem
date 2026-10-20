#!/usr/bin/env node
/**
 * Tests for the Cognee sub-wizard (providers/cognee/wizard.mjs and lib/):
 *   (a) hooks with stubbed helpers: init, hydrate, resolvePorts, configureModelRouting,
 *       stackEnv, beforeStack, summary, configToml, clackSetup
 *   (b) the smoke hook against a node:http stub that emulates Cognee
 *   (c) a real `wizard/bin/setup.mjs` run (and a dry run) against a copy of the providers
 *       directory whose cognee manifest is experimental, a fake `docker` on PATH and the stub
 *   (d) the validation hook
 * Everything runs in tmp dirs with a scratch HOME. No live stack, no docker, no real keys.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHelpers } from "../../wizard/lib/provider-wizard/helpers.mjs";
import { loadPmConfig } from "../../wizard/lib/pm-config.mjs";
import { validateManifest } from "../../wizard/lib/providers/registry.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const wiz = await import(pathToFileURL(path.join(ROOT, "providers/cognee/wizard.mjs")).href);
const { runSmoke } = await import(pathToFileURL(path.join(ROOT, "providers/cognee/lib/smoke.mjs")).href);
const shippedManifest = JSON.parse(fs.readFileSync(path.join(ROOT, "providers/cognee/manifest.json"), "utf8"));

let fails = 0;
/** @param {string} desc @param {boolean} ok @param {string} [detail] */
function check(desc, ok, detail = "") {
  if (ok) console.log(`ok    ${desc}`);
  else {
    console.log(`FAIL  ${desc}${detail ? `\n      ${detail.split("\n").join("\n      ")}` : ""}`);
    fails++;
  }
}

const tmpRoots = [];
/** @param {string} label */
function tmp(label) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `pm-cognee-${label}-`));
  tmpRoots.push(d);
  return d;
}
process.on("exit", () => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});

const SECRET = "sk-test-SECRET-0123456789";
const mode = (/** @type {string} */ p) => (fs.statSync(p).mode & 0o777).toString(8);

/** Remove every variable the Cognee hooks read, run `fn` with `vars` set, restore afterwards. */
async function withEnv(/** @type {Record<string, string>} */ vars, /** @type {() => Promise<void>} */ fn) {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) {
    if (/^(PM_COGNEE_|COGNEE_)/.test(k) || k === "LLM_API_KEY" || k === "WIZARD_SKIP_BACKEND_STEP") {
      delete process.env[k];
    }
  }
  Object.assign(process.env, vars);
  try {
    await fn();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

class DieError extends Error {}

/**
 * Helpers that record their output; `die` throws. `over` replaces any helper.
 * @param {Record<string, any>} [over]
 */
function makeHelpers(over = {}) {
  /** @type {{ kind: string, msg: string }[]} */
  const lines = [];
  const rec = (kind) => (msg) => void lines.push({ kind, msg: String(msg) });
  const h = createHelpers({
    info: rec("info"),
    ok: rec("ok"),
    warn: rec("warn"),
    die: (msg) => {
      lines.push({ kind: "die", msg: String(msg) });
      throw new DieError(String(msg));
    },
    ask: async () => {
      throw new Error("ask must not be called");
    },
    ...over,
  });
  const text = () => lines.map((l) => `${l.kind}: ${l.msg}`).join("\n");
  return { h, lines, text };
}

/** @param {string} home @param {Record<string, any>} [extra] */
function makeCtx(home, extra = {}) {
  return {
    repoRoot: path.join(home, "stack"),
    home,
    project: "pm-cognee-unit",
    wizardConf: path.join(home, ".config/hindsight/wizard.conf"),
    yes: true,
    dry: false,
    skipBackendStep: false,
    pmMerged: {},
    memoryProvider: { ...shippedManifest, status: "experimental" },
    validationErrors: [],
    validationChecks: [],
    ...extra,
  };
}

const envFileOf = (/** @type {string} */ home) => path.join(home, ".config/personal-memory/cognee.env");

// ---------------------------------------------------------------------------
// (a) hooks with stubbed helpers
// ---------------------------------------------------------------------------
console.log("--- (a) hooks");

check("exports the scripts/setup.mjs hooks", typeof wiz.prepareStackEnv === "function" && typeof wiz.setupNotices === "function");
for (const phase of ["init", "hydrate", "resolvePorts", "configureModelRouting", "stackEnv", "beforeStack", "smoke", "extendValidation", "configToml", "summary", "clackSetup"]) {
  check(`exports ${phase}`, typeof wiz[phase] === "function");
}

// init: [memory.cognee] and the environment.
await withEnv({}, async () => {
  const home = tmp("init");
  const { h } = makeHelpers();
  const ctx = makeCtx(home, {
    pmMerged: { memory: { provider: "cognee", cognee: { port: 18766, env_file: "~/custom/cognee.env" } } },
  });
  await wiz.init(ctx, h);
  check("init: TOML port is exported as COGNEE_PORT", process.env.COGNEE_PORT === "18766");
  check("init: TOML env_file is exported as an absolute COGNEE_ENV_FILE", process.env.COGNEE_ENV_FILE === path.join(home, "custom/cognee.env"));
  check("init: ctx.cognee.envFile follows it", ctx.cognee.envFile === path.join(home, "custom/cognee.env"));
  check("init: indexer env file has its default", ctx.cognee.indexerEnvFile === path.join(home, ".config/personal-memory/cognee-indexer.env"));
});
await withEnv({ COGNEE_PORT: "18700", COGNEE_ENV_FILE: "/somewhere/else.env" }, async () => {
  const home = tmp("init-env");
  const { h } = makeHelpers();
  const ctx = makeCtx(home, { pmMerged: { memory: { cognee: { port: 18766, env_file: "~/custom/cognee.env" } } } });
  await wiz.init(ctx, h);
  check("init: the environment wins over the TOML table", process.env.COGNEE_PORT === "18700" && ctx.cognee.envFile === "/somewhere/else.env");
});
await withEnv({}, async () => {
  const home = tmp("init-bad");
  const { h } = makeHelpers();
  const ctx = makeCtx(home, { pmMerged: { memory: { cognee: { port: 70000 } } } });
  let died = false;
  try {
    await wiz.init(ctx, h);
  } catch (e) {
    died = e instanceof DieError;
  }
  check("init: an out-of-range TOML port is rejected", died);
});
await withEnv({}, async () => {
  const home = tmp("init-default");
  const { h } = makeHelpers();
  const ctx = makeCtx(home);
  await wiz.init(ctx, h);
  check("init: defaults leave the environment alone", process.env.COGNEE_PORT === undefined && process.env.COGNEE_ENV_FILE === undefined);
  check("init: default env file is ~/.config/personal-memory/cognee.env", ctx.cognee.envFile === envFileOf(home));
});

// hydrate: the saved port.
await withEnv({}, async () => {
  const home = tmp("hydrate");
  fs.mkdirSync(path.join(home, ".config/hindsight"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config/hindsight/wizard.conf"), "MEMORY_PROVIDER=cognee\nCOGNEE_PORT=18777\n");
  const { h } = makeHelpers();
  await wiz.hydrate(makeCtx(home), h);
  check("hydrate: restores COGNEE_PORT from wizard.conf", process.env.COGNEE_PORT === "18777");
});
await withEnv({ COGNEE_PORT: "18999" }, async () => {
  const home = tmp("hydrate2");
  fs.mkdirSync(path.join(home, ".config/hindsight"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config/hindsight/wizard.conf"), "MEMORY_PROVIDER=cognee\nCOGNEE_PORT=18777\n");
  const { h } = makeHelpers();
  await wiz.hydrate(makeCtx(home), h);
  check("hydrate: an environment port wins over wizard.conf", process.env.COGNEE_PORT === "18999");
});

// resolvePorts.
await withEnv({}, async () => {
  const home = tmp("ports");
  /** @type {string[]} */
  const labels = [];
  const { h } = makeHelpers({
    resolveHostPort: async (_ctx, label) => {
      labels.push(label);
      return 18999;
    },
  });
  const ctx = makeCtx(home);
  await wiz.resolvePorts(ctx, h);
  check("resolvePorts: uses helpers.resolveHostPort with a Cognee label", labels.join() === "Cognee API");
  check("resolvePorts: sets portCognee and cogneeUrl", ctx.portCognee === "18999" && ctx.cogneeUrl === "http://127.0.0.1:18999");
  check("resolvePorts: exports COGNEE_PORT", process.env.COGNEE_PORT === "18999");
  const env = wiz.stackEnv(ctx);
  check("stackEnv: passes COGNEE_PORT to the stack setup script", env.env.COGNEE_PORT === "18999" && /COGNEE_PORT/.test(env.description));
});

// configureModelRouting.
await withEnv({ PM_COGNEE_LLM_API_KEY: SECRET, PM_COGNEE_LLM_MODEL: "gpt 4o mini", PM_COGNEE_EMBEDDING_DIMENSIONS: "1536" }, async () => {
  const home = tmp("llm");
  const file = envFileOf(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "# my notes\nFOO=bar\nLLM_API_KEY=old-value\nBAZ=1\nLLM_API_KEY=duplicate\n", { mode: 0o644 });
  const { h, text } = makeHelpers();
  /** @type {any[]} */
  const saved = [];
  const hh = createHelpers({ ...h, saveWizardConf: (...a) => void saved.push(a) });
  const ctx = makeCtx(home);
  ctx.portCognee = "18999";
  await wiz.init(ctx, hh);
  await wiz.configureModelRouting(ctx, hh);
  const body = fs.readFileSync(file, "utf8");
  check("llm: unrelated lines and comments are kept", body.includes("# my notes\n") && body.includes("FOO=bar\n") && body.includes("BAZ=1\n"));
  check("llm: LLM_API_KEY is replaced once, duplicates dropped", body.includes(`LLM_API_KEY=${SECRET}\n`) && !body.includes("old-value") && !body.includes("duplicate") && body.split("LLM_API_KEY=").length === 2);
  check("llm: pass-through values are written (quoted when needed)", body.includes("LLM_MODEL='gpt 4o mini'\n") && body.includes("EMBEDDING_DIMENSIONS=1536\n"));
  check("llm: file mode is 600", mode(file) === "600");
  check("llm: the secret is never printed", !text().includes(SECRET));
  check("llm: only key names and the path are printed", text().includes(file) && text().includes("LLM_API_KEY") && text().includes("LLM_MODEL"));
  check("llm: the secret answer is removed from the environment", process.env.PM_COGNEE_LLM_API_KEY === undefined);
  check("llm: no warning when a key is configured", !/warn:/.test(text()));
  check("llm: mentions how to enable auth by hand", /REQUIRE_AUTHENTICATION=true/.test(text()) && /cognee-indexer\.env/.test(text()));
  check("llm: wizard.conf gets COGNEE_PORT only", saved.length === 1 && JSON.stringify(saved[0][1]) === JSON.stringify({ COGNEE_PORT: "18999" }));
  check("llm: config.toml section carries no secret", !JSON.stringify(saved[0][2]).includes(SECRET));
  const toml = wiz.configToml(ctx);
  check("configToml: [memory.cognee] has port and env_file", toml.memory.provider === "cognee" && toml.memory.cognee.port === 18999 && toml.memory.cognee.env_file === "~/.config/personal-memory/cognee.env");
  check("configToml: holds no secret", !JSON.stringify(toml).includes(SECRET));

  // Second run with the same answers: byte for byte unchanged.
  process.env.PM_COGNEE_LLM_API_KEY = SECRET;
  const before = fs.readFileSync(file);
  const mtime = fs.statSync(file).mtimeMs;
  const again = makeHelpers();
  await wiz.configureModelRouting(ctx, createHelpers({ ...again.h, saveWizardConf: () => {} }));
  check("llm: same answers leave the file untouched", Buffer.compare(before, fs.readFileSync(file)) === 0 && fs.statSync(file).mtimeMs === mtime);
  check("llm: second run reports kept, not wrote", /kept /.test(again.text()) && !/wrote /.test(again.text()));
});

await withEnv({ PM_COGNEE_LLM_API_KEY: SECRET }, async () => {
  const home = tmp("llm-newdir");
  const { h } = makeHelpers({ saveWizardConf: () => {} });
  const ctx = makeCtx(home);
  await wiz.init(ctx, h);
  await wiz.configureModelRouting(ctx, h);
  const file = envFileOf(home);
  check("llm: a new env file is mode 600", mode(file) === "600");
  check("llm: its new directory is mode 700", mode(path.dirname(file)) === "700");
});

await withEnv({ LLM_API_KEY: SECRET }, async () => {
  const home = tmp("llm-fallback");
  const { h, text } = makeHelpers({ saveWizardConf: () => {} });
  const ctx = makeCtx(home);
  await wiz.init(ctx, h);
  await wiz.configureModelRouting(ctx, h);
  check("llm: --yes reads LLM_API_KEY when PM_COGNEE_LLM_API_KEY is unset", fs.readFileSync(envFileOf(home), "utf8").includes(`LLM_API_KEY=${SECRET}`));
  check("llm: LLM_API_KEY from the environment is not printed", !text().includes(SECRET));
});

await withEnv({}, async () => {
  const home = tmp("llm-nokey");
  const { h, text, lines } = makeHelpers({ saveWizardConf: () => {} });
  const ctx = makeCtx(home);
  await wiz.init(ctx, h);
  let threw = false;
  try {
    await wiz.configureModelRouting(ctx, h);
  } catch {
    threw = true;
  }
  check("llm: --yes without a key does not die", !threw);
  check(
    "llm: --yes without a key warns that documents are not searchable",
    lines.some((l) => l.kind === "warn" && l.msg.includes("documents will be stored but not searchable until LLM_API_KEY works (cognify needs it)")),
    text(),
  );
  check("llm: no env file is created without answers", !fs.existsSync(envFileOf(home)));
});

await withEnv({ PM_COGNEE_LLM_MODEL: "local-model", PM_COGNEE_LLM_PROVIDER: "ollama" }, async () => {
  const home = tmp("llm-local");
  const { h, lines } = makeHelpers({ saveWizardConf: () => {} });
  const ctx = makeCtx(home);
  await wiz.init(ctx, h);
  await wiz.configureModelRouting(ctx, h);
  const body = fs.readFileSync(envFileOf(home), "utf8");
  check("llm: a local model setup writes pass-through keys without a key", body === "LLM_PROVIDER=ollama\nLLM_MODEL=local-model\n");
  check("llm: ... and still warns about the missing key", lines.some((l) => l.kind === "warn"));
});

await withEnv({ PM_COGNEE_LLM_API_KEY: SECRET, PM_COGNEE_LLM_MODEL: "a\nb" }, async () => {
  const home = tmp("llm-newline");
  const { h } = makeHelpers({ saveWizardConf: () => {} });
  const ctx = makeCtx(home);
  await wiz.init(ctx, h);
  let died = "";
  try {
    await wiz.configureModelRouting(ctx, h);
  } catch (e) {
    died = e instanceof DieError ? e.message : "other";
  }
  check("llm: a multi-line answer is rejected by name, without its value", died.includes("LLM_MODEL") && !died.includes("a\nb"));
  check("llm: nothing is written for a rejected answer", !fs.existsSync(envFileOf(home)));
});

await withEnv({ PM_COGNEE_LLM_API_KEY: SECRET, PM_COGNEE_LLM_MODEL: "m" }, async () => {
  const home = tmp("llm-dry");
  const { h, text } = makeHelpers({
    saveWizardConf: () => {
      throw new Error("dry run must not save");
    },
  });
  const ctx = makeCtx(home, { dry: true });
  await wiz.init(ctx, h);
  await wiz.configureModelRouting(ctx, h);
  check("llm: dry run writes nothing (no directory either)", !fs.existsSync(path.join(home, ".config")));
  check("llm: dry run prints the plan with key names only", /\[dry-run\] write .*cognee\.env.*LLM_API_KEY, LLM_MODEL/.test(text()) && !text().includes(SECRET));
});

await withEnv({}, async () => {
  const home = tmp("llm-open");
  const file = envFileOf(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `LLM_API_KEY=${SECRET}\n`, { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  const { h } = makeHelpers({ saveWizardConf: () => {} });
  const ctx = makeCtx(home);
  await wiz.init(ctx, h);
  await wiz.configureModelRouting(ctx, h);
  check("llm: an existing key is kept and a too-open mode is tightened", fs.readFileSync(file, "utf8") === `LLM_API_KEY=${SECRET}\n` && mode(file) === "600");
});

await withEnv({ PM_COGNEE_LLM_API_KEY: SECRET }, async () => {
  const home = tmp("llm-skip");
  const { h } = makeHelpers({ saveWizardConf: () => {} });
  const ctx = makeCtx(home, { yes: false, skipBackendStep: true });
  await wiz.init(ctx, h);
  await wiz.configureModelRouting(ctx, h);
  check("llm: skipBackendStep takes the answer from the environment and never asks", fs.readFileSync(envFileOf(home), "utf8").includes(SECRET));
});
await withEnv({}, async () => {
  const home = tmp("llm-ask");
  /** @type {string[]} */
  const prompts = [];
  const { h, text } = makeHelpers({
    saveWizardConf: () => {},
    ask: async (_c, prompt) => {
      prompts.push(prompt);
      return SECRET;
    },
  });
  const ctx = makeCtx(home, { yes: false });
  await wiz.init(ctx, h);
  await wiz.configureModelRouting(ctx, h);
  check("llm: an interactive run asks once through helpers.ask", prompts.length === 1 && /LLM_API_KEY/.test(prompts[0]));
  check("llm: the typed key lands in the env file only", fs.readFileSync(envFileOf(home), "utf8").includes(SECRET) && !text().includes(SECRET));
});

// beforeStack.
await withEnv({}, async () => {
  const home = tmp("before");
  const { h, lines } = makeHelpers();
  const ctx = makeCtx(home);
  await wiz.init(ctx, h);
  const dir = path.join(home, ".config/personal-memory");
  await wiz.beforeStack({ ...ctx, dry: true }, h);
  check("beforeStack: dry run creates nothing and says so", !fs.existsSync(dir) && lines.some((l) => /\[dry-run\] create .*personal-memory/.test(l.msg)));
  await wiz.beforeStack(ctx, h);
  check("beforeStack: creates the env directory with mode 700", fs.existsSync(dir) && mode(dir) === "700");
  fs.writeFileSync(path.join(dir, "cognee.env"), "LLM_API_KEY=x\n", { mode: 0o640 });
  fs.chmodSync(path.join(dir, "cognee.env"), 0o640);
  const second = makeHelpers();
  await wiz.beforeStack(ctx, second.h);
  check("beforeStack: warns when cognee.env is group-readable, without printing contents", second.lines.some((l) => l.kind === "warn" && /cognee\.env/.test(l.msg) && !l.msg.includes("LLM_API_KEY=x")));
  check("beforeStack: leaves the file mode alone", mode(path.join(dir, "cognee.env")) === "640");
});

// summary.
await withEnv({}, async () => {
  const home = tmp("summary");
  const { h } = makeHelpers();
  const ctx = makeCtx(home);
  await wiz.init(ctx, h);
  ctx.portCognee = "18999";
  ctx.cogneeUrl = "http://127.0.0.1:18999";
  const s = wiz.summary(ctx);
  const all = [...s.running, ...s.configFiles, ...s.notes].join("\n");
  check("summary: running lines", s.running.some((l) => l.includes("http://127.0.0.1:18999") && l.includes("/docs")) && s.running.some((l) => l.includes("cognee -> http://cognee:8000")) && /asynchronous/.test(s.running.join()));
  check("summary: config files name cognee.env and the stack .env", s.configFiles.some((l) => l.includes(envFileOf(home))) && s.configFiles.some((l) => l.includes(path.join(ctx.repoRoot, ".env"))));
  check("summary: indexer env file listed only when it exists", !s.configFiles.some((l) => l.includes("cognee-indexer.env")));
  fs.mkdirSync(path.join(home, ".config/personal-memory"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config/personal-memory/cognee-indexer.env"), "COGNEE_API_KEY=k\n");
  check("summary: ... and listed once it does", wiz.summary(ctx).configFiles.some((l) => l.includes("cognee-indexer.env")));
  check("summary: notes cover the LLM key, graph status, first start and delete semantics", /LLM_API_KEY/.test(all) && /api\/v1\/datasets\/status/.test(all) && /large image/.test(all) && /graph and vectors/.test(all));
  check("summary: no secret text", !all.includes("COGNEE_API_KEY=k"));
  check("summary: log services", s.logServices.join() === "cognee,indexer");
});

// clackSetup.
await withEnv({}, async () => {
  const home = tmp("clack");
  const { h } = makeHelpers();
  /** @type {string[]} */
  const asked = [];
  const ui = {
    password: async ({ message }) => (asked.push(message), `  ${SECRET} `),
    confirm: async () => true,
    isCancel: () => false,
    cancel: () => {},
    log: { info: () => {} },
  };
  const handoff = await wiz.clackSetup({ repoRoot: path.join(home, "stack"), home, pmMerged: {} }, ui, h);
  check("clackSetup: uses a hidden password prompt", asked.length === 1 && /hidden/.test(asked[0]));
  check("clackSetup: hands the key over as PM_COGNEE_LLM_API_KEY and skips the wizard's own step", handoff.PM_COGNEE_LLM_API_KEY === SECRET && handoff.WIZARD_SKIP_BACKEND_STEP === "1");
  const empty = await wiz.clackSetup({ repoRoot: home, home, pmMerged: {} }, { ...ui, password: async () => "" }, h);
  check("clackSetup: an empty answer hands over no key", empty.PM_COGNEE_LLM_API_KEY === undefined && empty.WIZARD_SKIP_BACKEND_STEP === "1");
  fs.mkdirSync(path.join(home, ".config/personal-memory"), { recursive: true });
  fs.writeFileSync(envFileOf(home), `LLM_API_KEY=${SECRET}\n`);
  /** @type {string[]} */
  const passwordCalls = [];
  const kept = await wiz.clackSetup({ repoRoot: home, home, pmMerged: {} }, { ...ui, confirm: async () => false, password: async () => (passwordCalls.push("x"), "new") }, h);
  check("clackSetup: an existing key is kept unless the user replaces it", passwordCalls.length === 0 && kept.PM_COGNEE_LLM_API_KEY === undefined);
});

// ---------------------------------------------------------------------------
// Cognee stub (node:http)
// ---------------------------------------------------------------------------

/** @param {string} contentType @param {Buffer} buf */
function parseMultipart(contentType, buf) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType || "");
  const boundary = m?.[1] || m?.[2] || "";
  /** @type {{ name: string, filename: string, content: string }[]} */
  const parts = [];
  for (const chunk of buf.toString("latin1").split(`--${boundary}`).slice(1)) {
    if (chunk.startsWith("--")) break;
    const cut = chunk.indexOf("\r\n\r\n");
    const head = chunk.slice(0, cut);
    parts.push({
      name: /name="([^"]*)"/.exec(head)?.[1] || "",
      filename: /filename="([^"]*)"/.exec(head)?.[1] || "",
      content: chunk.slice(cut + 4).replace(/\r\n$/, ""),
    });
  }
  return parts;
}

/**
 * Emulates the Cognee endpoints the wizard uses. Options: addStatus, emptyList, healthDown,
 * healthFailures, deleteStatus, requireKey, metaStyle ("object" | "array" | "none" | "other").
 * @param {Record<string, any>} [opts]
 */
async function startCognee(opts = {}) {
  /** @type {Map<string, { id: string, name: string, items: any[] }>} */
  const datasets = new Map();
  /** @type {{ method: string, url: string, headers: http.IncomingHttpHeaders, body: Buffer }[]} */
  const requests = [];
  /** @type {ReturnType<typeof parseMultipart>[]} */
  const adds = [];
  let healthFailures = opts.healthFailures || 0;
  const server = http.createServer(async (req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = req.url || "";
    requests.push({ method: req.method || "", url, headers: req.headers, body });
    const send = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(obj === undefined ? "" : JSON.stringify(obj));
    };
    if (opts.requireKey && req.headers["x-api-key"] !== opts.requireKey) return send(401, { detail: "unauthorized" });
    if (req.method === "GET" && url === "/health") {
      if (opts.healthDown) return send(503, { status: "down" });
      if (healthFailures > 0) {
        healthFailures--;
        return send(503, { status: "starting" });
      }
      return send(200, { status: "ready" });
    }
    if (req.method === "POST" && url === "/api/v1/datasets") {
      const { name } = JSON.parse(body.toString("utf8"));
      let ds = [...datasets.values()].find((d) => d.name === name);
      if (!ds) {
        ds = { id: crypto.randomUUID(), name, items: [] };
        datasets.set(ds.id, ds);
      }
      return send(200, { id: ds.id, name: ds.name });
    }
    if (req.method === "POST" && url === "/api/v1/add") {
      if (opts.addStatus) return send(opts.addStatus, { detail: "ingest exploded" });
      const parts = parseMultipart(String(req.headers["content-type"]), body);
      adds.push(parts);
      const name = parts.find((p) => p.name === "datasetName")?.content;
      const ds = [...datasets.values()].find((d) => d.name === name);
      if (!ds) return send(404, { detail: "dataset not found" });
      const metaText = parts.find((p) => p.name === "external_metadata")?.content || "[]";
      const meta = JSON.parse(metaText);
      const style = opts.metaStyle || "object";
      const item = { id: crypto.randomUUID(), name: parts.find((p) => p.name === "data")?.filename };
      if (style === "object") item.externalMetadata = meta[0];
      else if (style === "array") item.externalMetadata = meta;
      else if (style === "other") item.externalMetadata = { doc_id: "someone-else" };
      ds.items.push(item);
      return send(200, { status: "PipelineRunCompleted" });
    }
    const dataRoute = /^\/api\/v1\/datasets\/([^/]+)\/data$/.exec(url);
    if (req.method === "GET" && dataRoute) {
      const ds = datasets.get(dataRoute[1]);
      if (!ds) return send(404, { detail: "no such dataset" });
      return send(200, opts.emptyList ? [] : ds.items);
    }
    const dsRoute = /^\/api\/v1\/datasets\/([^/]+)$/.exec(url);
    if (req.method === "DELETE" && dsRoute) {
      if (opts.deleteStatus) return send(opts.deleteStatus, { detail: "cannot delete" });
      return datasets.delete(dsRoute[1]) ? send(200, {}) : send(404, { detail: "no such dataset" });
    }
    return send(404, { detail: "not found" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    datasets,
    requests,
    adds,
    close: () => new Promise((r) => server.close(() => r(undefined))),
  };
}

const FAST = { healthTimeoutMs: 400, healthIntervalMs: 10, requestTimeoutMs: 5000, addTimeoutMs: 5000 };

/**
 * @param {Record<string, any>} stubOpts
 * @param {{ env?: Record<string, string>, indexerEnv?: string, dry?: boolean, timing?: Record<string, number> }} [run]
 */
async function smokeScenario(stubOpts, run = {}) {
  const stub = await startCognee(stubOpts);
  const home = tmp("smoke");
  /** @type {{ threw: string, lines: any[], text: () => string, stub: typeof stub, home: string }} */
  let result;
  await withEnv(run.env || {}, async () => {
    const { h, lines, text } = makeHelpers({
      apiBase: async () => stub.base,
      composeArgs: (_ctx, ...rest) => ["compose", "-p", "pm-cognee-unit", "-f", "compose.yaml", "--profile", "cognee", ...rest],
    });
    const ctx = makeCtx(home, { dry: Boolean(run.dry) });
    await wiz.init(ctx, h);
    if (run.indexerEnv !== undefined) {
      fs.mkdirSync(path.dirname(ctx.cognee.indexerEnvFile), { recursive: true });
      fs.writeFileSync(ctx.cognee.indexerEnvFile, run.indexerEnv);
    }
    let threw = "";
    try {
      await runSmoke(ctx, h, { ...FAST, ...(run.timing || {}) });
    } catch (e) {
      threw = e instanceof DieError ? e.message : `unexpected: ${/** @type {Error} */ (e).message}`;
    }
    result = { threw, lines, text, stub, home };
  });
  await stub.close();
  return /** @type {NonNullable<typeof result>} */ (result);
}

// ---------------------------------------------------------------------------
// (b) smoke
// ---------------------------------------------------------------------------
console.log("--- (b) smoke");

{
  const r = await smokeScenario({});
  const routes = r.stub.requests.map((q) => `${q.method} ${q.url.replace(/[0-9a-f-]{36}/, "<id>")}`);
  check("smoke: happy path does not die", r.threw === "", r.text());
  check(
    "smoke: calls health, create, add, list, delete in order",
    JSON.stringify(routes) === JSON.stringify(["GET /health", "POST /api/v1/datasets", "POST /api/v1/add", "GET /api/v1/datasets/<id>/data", "DELETE /api/v1/datasets/<id>"]),
    routes.join("\n"),
  );
  check("smoke: ends with the dataset deleted", r.stub.datasets.size === 0);
  const create = r.stub.requests[1];
  check("smoke: dataset create body is {name: wizard_smoke}", JSON.parse(create.body.toString()).name === "wizard_smoke" && /application\/json/.test(String(create.headers["content-type"])));
  const add = r.stub.requests[2];
  check("smoke: add is multipart/form-data", /^multipart\/form-data; boundary=/.test(String(add.headers["content-type"])));
  const parts = r.stub.adds[0] || [];
  const byName = Object.fromEntries(parts.map((p) => [p.name, p]));
  check("smoke: add carries datasetName", byName.datasetName?.content === "wizard_smoke");
  check("smoke: add carries the file wizard-smoke.md with the smoke text", byName.data?.filename === "wizard-smoke.md" && byName.data?.content === "Wizard smoke test: the project codename is heron.");
  check("smoke: add carries external_metadata [{doc_id: wizard-smoke}]", JSON.stringify(JSON.parse(byName.external_metadata?.content || "null")) === JSON.stringify([{ doc_id: "wizard-smoke" }]));
  check("smoke: no X-Api-Key without a configured key", r.stub.requests.every((q) => q.headers["x-api-key"] === undefined));
  check("smoke: prints the recall-skipped line and does not call cognify or search", /recall skipped: Cognee ingests asynchronously \(add, then cognify\); search results appear once the graph is built/.test(r.text()) && !r.stub.requests.some((q) => /cognify|search/.test(q.url)));
}

{
  const r = await smokeScenario({ healthFailures: 3 });
  check("smoke: waits for /health to turn healthy", r.threw === "" && r.stub.requests.filter((q) => q.url === "/health").length === 4 && r.stub.datasets.size === 0);
}

{
  const r = await smokeScenario({ healthDown: true });
  check("smoke: a server that never gets healthy dies with a hint, creating nothing", r.threw.includes("/health") && r.threw.includes("logs cognee") && !r.stub.requests.some((q) => q.url.startsWith("/api")));
}

{
  const r = await smokeScenario({ addStatus: 500 });
  check("smoke: a failing add dies with the status, the server detail and a compose logs hint", /add failed \(HTTP 500: ingest exploded\)/.test(r.threw) && /docker compose -p pm-cognee-unit -f compose\.yaml --profile cognee logs cognee/.test(r.threw) && /LLM_API_KEY/.test(r.threw), r.threw);
  check("smoke: a failing add still deletes the dataset", r.stub.datasets.size === 0 && r.stub.requests.at(-1)?.method === "DELETE");
}

{
  const r = await smokeScenario({ emptyList: true });
  check("smoke: an empty listing dies", /listing is empty/.test(r.threw) && /logs cognee/.test(r.threw), r.threw);
  check("smoke: an empty listing still deletes the dataset", r.stub.datasets.size === 0);
}

{
  const r = await smokeScenario({ metaStyle: "none" });
  check("smoke: a listing without external metadata is accepted", r.threw === "" && r.stub.datasets.size === 0);
}
{
  const r = await smokeScenario({ metaStyle: "array" });
  check("smoke: external metadata as an array with the doc_id is accepted", r.threw === "");
}
{
  const r = await smokeScenario({ metaStyle: "other" });
  check("smoke: a different doc_id fails (and still cleans up)", /doc_id/.test(r.threw) && r.stub.datasets.size === 0, r.threw);
}

{
  const r = await smokeScenario({ deleteStatus: 500 });
  check("smoke: a failing delete only warns", r.threw === "" && r.lines.some((l) => l.kind === "warn" && /could not delete smoke dataset/.test(l.msg) && /DELETE http/.test(l.msg)), r.text());
}
{
  const r = await smokeScenario({ deleteStatus: 500, addStatus: 500 });
  check("smoke: add failure plus delete failure still dies with the add failure", /add failed/.test(r.threw) && r.lines.some((l) => l.kind === "warn"));
}

{
  const KEY = "cognee-key-abc123";
  const r = await smokeScenario({ requireKey: KEY }, { indexerEnv: `COGNEE_API_KEY=${KEY}\n` });
  check("smoke: sends X-Api-Key from the indexer env file on every request", r.threw === "" && r.stub.requests.length === 5 && r.stub.requests.every((q) => q.headers["x-api-key"] === KEY), r.text());
  check("smoke: the API key is never printed", !r.text().includes(KEY));
}
{
  const KEY = "cognee-key-from-env";
  const r = await smokeScenario({ requireKey: KEY }, { env: { COGNEE_API_KEY: KEY }, indexerEnv: "COGNEE_API_KEY=other\n" });
  check("smoke: COGNEE_API_KEY in the environment wins over the file", r.threw === "" && r.stub.requests.every((q) => q.headers["x-api-key"] === KEY));
}
{
  const r = await smokeScenario({ requireKey: "needed" });
  check("smoke: an auth-protected server without a key dies with the logs hint", /\/health/.test(r.threw) && /logs cognee/.test(r.threw) && r.stub.datasets.size === 0, r.threw);
}

{
  const r = await smokeScenario({}, { dry: true });
  check("smoke: dry run sends no request and prints the five steps", r.stub.requests.length === 0 && ["/health", "/api/v1/datasets", "/api/v1/add", "/data must list", "DELETE"].every((s) => r.text().includes(s)));
  check("smoke: dry run also states that recall is skipped", /recall skipped/.test(r.text()));
}

// ---------------------------------------------------------------------------
// (d) validation hook
// ---------------------------------------------------------------------------
console.log("--- (d) validation");

/** @param {(home: string, ctx: any) => void} arrange */
async function validation(arrange) {
  let out;
  await withEnv({}, async () => {
    const home = tmp("validate");
    const { h } = makeHelpers();
    const ctx = makeCtx(home);
    fs.mkdirSync(path.join(ctx.repoRoot, "providers/cognee"), { recursive: true });
    fs.copyFileSync(path.join(ROOT, "providers/cognee/compose.yaml"), path.join(ctx.repoRoot, "providers/cognee/compose.yaml"));
    fs.writeFileSync(path.join(ctx.repoRoot, ".env"), "HOST_UID=1\nHOST_GID=1\nCOGNEE_PORT=8766\nCOMPOSE_PROFILES=cognee\n");
    await wiz.init(ctx, h);
    fs.mkdirSync(path.dirname(ctx.cognee.envFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(ctx.cognee.envFile, `LLM_API_KEY=${SECRET}\n`, { mode: 0o600 });
    fs.chmodSync(ctx.cognee.envFile, 0o600);
    arrange(home, ctx);
    await wiz.extendValidation(ctx, h);
    out = { errors: ctx.validationErrors, checks: ctx.validationChecks };
  });
  return out;
}

{
  const v = await validation(() => {});
  check("validate: a healthy setup has no errors", v.errors.length === 0, v.errors.join("\n"));
  check("validate: healthy setup records positive checks", v.checks.some((c) => /LLM_API_KEY/.test(c)) && v.checks.some((c) => /COGNEE_PORT/.test(c)) && v.checks.some((c) => /compose fragment/.test(c)));
}
{
  const v = await validation((_h, ctx) => fs.writeFileSync(ctx.cognee.envFile, "LLM_MODEL=x\n", { mode: 0o600 }));
  check("validate: a missing LLM key is a warning-class check, not an error", v.errors.length === 0 && v.checks.includes("LLM_API_KEY missing: documents are stored but not searchable"), JSON.stringify(v));
}
{
  const v = await validation((_h, ctx) => fs.rmSync(ctx.cognee.envFile));
  check("validate: no cognee.env is the same warning-class check", v.errors.length === 0 && v.checks.includes("LLM_API_KEY missing: documents are stored but not searchable"));
}
{
  const v = await validation((_h, ctx) => fs.chmodSync(ctx.cognee.envFile, 0o640));
  check("validate: a group-readable cognee.env is an error", v.errors.some((e) => /cognee\.env must not be world\/group readable/.test(e)) && !v.errors.join().includes(SECRET));
}
{
  const v = await validation((_h, ctx) => {
    fs.chmodSync(ctx.cognee.envFile, 0o000);
  });
  const isRoot = process.getuid?.() === 0;
  check("validate: an unreadable cognee.env is an error", isRoot || v.errors.some((e) => /not readable/.test(e)), JSON.stringify(v));
}
{
  const v = await validation((_h, ctx) => fs.writeFileSync(path.join(ctx.repoRoot, ".env"), "HOST_UID=1\nHOST_GID=1\n"));
  check("validate: stack .env without COGNEE_PORT is an error", v.errors.includes("repo .env missing COGNEE_PORT"));
}
{
  const v = await validation((_h, ctx) => fs.appendFileSync(path.join(ctx.repoRoot, ".env"), "LLM_API_KEY=oops\n"));
  check("validate: LLM_API_KEY text in the stack .env is an error", v.errors.some((e) => /repo \.env must not contain/.test(e)) && !v.errors.join().includes("oops"));
}
{
  const v = await validation((_h, ctx) => fs.appendFileSync(path.join(ctx.repoRoot, ".env"), "# COGNEE_API_KEY=oops\n"));
  check("validate: COGNEE_API_KEY text in the stack .env is an error", v.errors.some((e) => /repo \.env must not contain/.test(e)));
}
{
  const v = await validation((_h, ctx) => fs.rmSync(path.join(ctx.repoRoot, "providers/cognee/compose.yaml")));
  check("validate: a missing compose fragment is an error", v.errors.some((e) => /missing compose fragment providers\/cognee\/compose\.yaml/.test(e)));
}
{
  const v = await validation((_h, ctx) => fs.appendFileSync(path.join(ctx.repoRoot, "providers/cognee/compose.yaml"), "# image: placeholder\n"));
  check("validate: a placeholder in the fragment is an error", v.errors.some((e) => /unfinished image text/.test(e)));
}
{
  const v = await validation((_h, ctx) => {
    fs.writeFileSync(ctx.cognee.indexerEnvFile, `COGNEE_API_KEY=k\nLLM_API_KEY=${SECRET}\n`, { mode: 0o644 });
    fs.chmodSync(ctx.cognee.indexerEnvFile, 0o644);
  });
  check("validate: the indexer env file must be private and must not hold LLM_API_KEY", v.errors.some((e) => /cognee-indexer\.env must not be world\/group/.test(e)) && v.errors.some((e) => /must not hold LLM_API_KEY/.test(e)) && !v.errors.join().includes(SECRET));
}
{
  const shipped = path.join(ROOT, "providers/cognee/compose.yaml");
  check("validate: the shipped fragment has no placeholder", !/placeholder/i.test(fs.readFileSync(shipped, "utf8")));
}

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------
console.log("--- manifest");
{
  check("manifest: the shipped status is experimental", shippedManifest.status === "experimental");
  const errors = validateManifest(shippedManifest);
  check("manifest: valid at experimental", errors.length === 0, errors.join("\n"));
  check("manifest: sink and driver", shippedManifest.indexer.sink === "cognee" && shippedManifest.indexer.sinkDriver === "cognee-rest" && shippedManifest.indexer.apiUrlEnv === "COGNEE_API_URL");
  check("manifest: smoke fields", shippedManifest.wizard.smokeBank === "wizard-smoke" && shippedManifest.wizard.retainPath === "/api/v1/add" && shippedManifest.wizard.recallPath === "/api/v1/search" && shippedManifest.wizard.deleteMethod === "DELETE");
  check("manifest: native config paths name both env files", shippedManifest.settings.nativeConfigPaths.join() === "~/.config/personal-memory/cognee.env,~/.config/personal-memory/cognee-indexer.env");
  check("manifest: wizardOwns has no TBD text", !shippedManifest.settings.wizardOwns.some((l) => /TBD/.test(l)));
}

// ---------------------------------------------------------------------------
// (c) a real wizard run
// ---------------------------------------------------------------------------
console.log("--- (c) real wizard run");

const DOCKER_STUB = `#!/usr/bin/env bash
echo "docker $*" >> "\${STUB_LOG}"
case "$1" in
    info) exit 0 ;;
    ps)
        case "$*" in *publish=*) echo "\${STUB_PROJECT}" ;; esac
        exit 0 ;;
    compose)
        case "$*" in
            *" version"*) echo "Docker Compose version v2.29.0" ;;
            *" run "*) printf 'repo\\t%s/src/demo-repo\\n' "\${HOME}" ;;
        esac ;;
esac
exit 0
`;

/**
 * A scratch world: HOME, a stack root with the files compose and the indexer image need, a
 * providers directory whose cognee manifest is experimental (with the wizard/ symlink the
 * providers' relative imports need), and a fake docker on PATH.
 * @param {string} label
 */
function makeWorld(label) {
  const base = tmp(label);
  const home = path.join(base, "home");
  const stack = path.join(base, "stack");
  const providers = path.join(base, "providers");
  const bin = path.join(base, "bin");
  fs.mkdirSync(path.join(home, "src/demo-repo"), { recursive: true });
  fs.mkdirSync(stack, { recursive: true });
  fs.mkdirSync(bin);
  const skip = (/** @type {string} */ src) => !/__pycache__|\.pytest_cache|node_modules/.test(src);
  fs.cpSync(path.join(ROOT, "providers"), providers, { recursive: true, filter: skip });
  fs.symlinkSync(path.join(ROOT, "wizard"), path.join(base, "wizard"));
  const manifestFile = path.join(providers, "cognee/manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  manifest.status = "experimental";
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  for (const rel of ["compose.yaml", "indexer", "bin", "config"]) {
    fs.cpSync(path.join(ROOT, rel), path.join(stack, rel), { recursive: true, filter: skip });
  }
  fs.mkdirSync(path.join(stack, "providers/cognee"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "providers/cognee/compose.yaml"), path.join(stack, "providers/cognee/compose.yaml"));
  fs.writeFileSync(path.join(bin, "docker"), DOCKER_STUB, { mode: 0o755 });
  return { base, home, stack, providers, bin, log: path.join(base, "docker.log") };
}

/** @param {string} dir @returns {string[]} sorted "relative-path hash" lines */
function tree(dir) {
  /** @type {string[]} */
  const out = [];
  const walk = (/** @type {string} */ d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) {
        out.push(`${path.relative(dir, p)}/`);
        walk(p);
      } else out.push(`${path.relative(dir, p)} ${crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")}`);
    }
  };
  walk(dir);
  return out.sort();
}

/** @param {string} dir @param {string} needle files under `dir` whose bytes contain `needle` */
function filesContaining(dir, needle) {
  /** @type {string[]} */
  const hits = [];
  const walk = (/** @type {string} */ d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && fs.readFileSync(p).includes(needle)) hits.push(path.relative(dir, p));
    }
  };
  walk(dir);
  return hits;
}

/**
 * @param {ReturnType<typeof makeWorld>} w
 * @param {number} port
 * @param {string[]} args
 * @returns {Promise<{ code: number | null, out: string }>}
 */
function runWizard(w, port, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "wizard/bin/setup.mjs"), ...args], {
      cwd: w.base,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: `${w.bin}:/usr/bin:/bin`,
        LANG: "C.UTF-8",
        TERM: "dumb",
        HOME: w.home,
        STUB_LOG: w.log,
        STUB_PROJECT: "pm-cognee-test",
        PM_PROJECT: "pm-cognee-test",
        PM_STACK_ROOT: w.stack,
        PM_PROVIDERS_DIR: w.providers,
        MEMORY_PROVIDER: "cognee",
        COGNEE_PORT: String(port),
        PM_COGNEE_LLM_API_KEY: SECRET,
        PM_COGNEE_LLM_MODEL: "test-model",
      },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => {
      if (process.env.COGNEE_TEST_VERBOSE) console.log(out);
      resolve({ code, out });
    });
  });
}

{
  const stub = await startCognee({});
  const w = makeWorld("real");
  const r = await runWizard(w, stub.port, ["--yes"]);
  check("real run: exits 0", r.code === 0, r.out.split("\n").slice(-25).join("\n"));
  const log = fs.existsSync(w.log) ? fs.readFileSync(w.log, "utf8") : "";
  check(
    "real run: docker compose up carries the profile and the compose files",
    /compose -p pm-cognee-test -f compose\.yaml( -f compose\.override\.yaml)? -f providers\/cognee\/compose\.yaml --profile cognee up -d/.test(log),
    log,
  );
  const stackEnv = fs.existsSync(path.join(w.stack, ".env")) ? fs.readFileSync(path.join(w.stack, ".env"), "utf8") : "";
  check("real run: stack .env has COGNEE_PORT and COMPOSE_PROFILES", stackEnv.includes(`COGNEE_PORT=${stub.port}\n`) && stackEnv.includes("COMPOSE_PROFILES=cognee\n"), stackEnv);
  check("real run: stack .env holds no secret and no secret names", !stackEnv.includes(SECRET) && !/LLM_API_KEY|COGNEE_API_KEY/.test(stackEnv));
  const envFile = envFileOf(w.home);
  check("real run: cognee.env exists with mode 600 and the key", fs.existsSync(envFile) && mode(envFile) === "600" && fs.readFileSync(envFile, "utf8").includes(`LLM_API_KEY=${SECRET}`));
  check("real run: cognee.env also has the pass-through model", fs.readFileSync(envFile, "utf8").includes("LLM_MODEL=test-model"));
  check("real run: the env directory is mode 700", mode(path.dirname(envFile)) === "700");
  check(
    "real run: the secret is in no other file (stack, home, docker log)",
    JSON.stringify([...filesContaining(w.home, SECRET), ...filesContaining(w.stack, SECRET), ...filesContaining(w.base, SECRET).filter((f) => f === "docker.log")]) === JSON.stringify([path.relative(w.home, envFile)]),
    JSON.stringify([...filesContaining(w.home, SECRET), ...filesContaining(w.stack, SECRET)]),
  );
  check("real run: the secret is not in the wizard output", !r.out.includes(SECRET));
  const conf = fs.readFileSync(path.join(w.home, ".config/hindsight/wizard.conf"), "utf8");
  check("real run: wizard.conf records the provider and port only", conf === `MEMORY_PROVIDER=cognee\nCOGNEE_PORT=${stub.port}\n`, conf);
  const toml = fs.readFileSync(path.join(w.home, ".config/personal-memory/config.toml"), "utf8");
  check("real run: config.toml has [memory.cognee] with port and env_file", /\[memory\.cognee\]/.test(toml) && /port = [0-9_]+/.test(toml) && loadPmConfig(w.home, w.stack).merged.memory?.cognee?.port === stub.port && toml.includes('env_file = "~/.config/personal-memory/cognee.env"') && /provider = "cognee"/.test(toml), toml);
  check("real run: hooks were announced", ["resolvePorts", "configureModelRouting", "beforeStack", "smoke", "extendValidation"].every((p) => r.out.includes(`provider cognee: ${p}`)));
  check("real run: the stub saw the smoke calls", ["GET /health", "POST /api/v1/datasets", "POST /api/v1/add", "DELETE /api/v1/datasets/"].every((s) => stub.requests.some((q) => `${q.method} ${q.url}`.startsWith(s))));
  check("real run: the smoke dataset is gone", stub.datasets.size === 0);
  check("real run: smoke printed the recall-skipped line", /recall skipped/.test(r.out));
  check("real run: memory validation passed", /memory setup validation passed/.test(r.out), r.out.split("\n").filter((l) => /warn|error|check/.test(l)).join("\n"));
  check("real run: summary names the Cognee API and cognify note", r.out.includes(`Cognee API         http://127.0.0.1:${stub.port}`) && /cognify/.test(r.out));
  check("real run: summary note reflects a configured key", /Cognee builds its graph with the LLM configured in/.test(r.out) && !/Cognee needs an LLM key/.test(r.out));
  check("real run: no LLM warning when a key was given", !/not searchable until LLM_API_KEY works/.test(r.out));
  check("real run: stack override masks the env directory", fs.existsSync(path.join(w.stack, "compose.override.yaml")) && fs.readFileSync(path.join(w.stack, "compose.override.yaml"), "utf8").includes(path.join(w.home, ".config/personal-memory")));

  // A second run changes nothing.
  const before = tree(w.home);
  stub.requests.length = 0;
  const again = await runWizard(w, stub.port, ["--yes"]);
  check("real run: a second run exits 0", again.code === 0, again.out.split("\n").slice(-15).join("\n"));
  check("real run: a second run reports changed=0", /wizard: changed=0/.test(again.out), again.out.split("\n").slice(-6).join("\n"));
  check("real run: a second run leaves HOME unchanged", JSON.stringify(tree(w.home)) === JSON.stringify(before));
  check("real run: a second run smokes again and cleans up", stub.requests.some((q) => q.method === "POST" && q.url === "/api/v1/add") && stub.datasets.size === 0);
  await stub.close();
}

{
  // No key under --yes: the run completes with a warning.
  const stub = await startCognee({});
  const w = makeWorld("nokey");
  const child = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, "wizard/bin/setup.mjs"), "--yes"], {
      cwd: w.base,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: `${w.bin}:/usr/bin:/bin`, LANG: "C.UTF-8", TERM: "dumb", HOME: w.home, STUB_LOG: w.log,
        STUB_PROJECT: "pm-cognee-test", PM_PROJECT: "pm-cognee-test", PM_STACK_ROOT: w.stack,
        PM_PROVIDERS_DIR: w.providers, MEMORY_PROVIDER: "cognee", COGNEE_PORT: String(stub.port),
      },
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });
  const { code, out } = /** @type {{ code: number | null, out: string }} */ (child);
  check("no key: --yes still exits 0", code === 0, out.split("\n").slice(-15).join("\n"));
  check("no key: warns that documents are not searchable", /documents will be stored but not searchable until LLM_API_KEY works \(cognify needs it\)/.test(out));
  check("no key: validation reports the missing key without failing", /LLM_API_KEY missing: documents are stored but not searchable/.test(out) && /memory setup validation passed/.test(out));
  check("no key: summary tells the operator what to set", /Cognee needs an LLM key to build its graph/.test(out));
  check("no key: no cognee.env is created", !fs.existsSync(envFileOf(w.home)));
  await stub.close();
}

{
  const stub = await startCognee({});
  const w = makeWorld("dry");
  const homeBefore = tree(w.home);
  const stackBefore = tree(w.stack);
  const r = await runWizard(w, stub.port, ["--yes", "--dry-run"]);
  check("dry run: exits 0", r.code === 0, r.out.split("\n").slice(-25).join("\n"));
  check("dry run: writes nothing under HOME or the stack root", JSON.stringify(tree(w.home)) === JSON.stringify(homeBefore) && JSON.stringify(tree(w.stack)) === JSON.stringify(stackBefore));
  check("dry run: sends no request to Cognee", stub.requests.length === 0);
  const log = fs.existsSync(w.log) ? fs.readFileSync(w.log, "utf8") : "";
  check("dry run: docker is never asked to up, build or run", !/compose .* (up|build|run) /.test(log));
  check("dry run: prints the compose plan with profile and files", /\[dry-run\] docker compose -p pm-cognee-test -f compose\.yaml -f providers\/cognee\/compose\.yaml --profile cognee up -d/.test(r.out), r.out);
  check("dry run: prints the env file plan with key names only", /\[dry-run\] write .*cognee\.env.*LLM_API_KEY/.test(r.out) && !r.out.includes(SECRET));
  check("dry run: prints the five smoke steps", /\[dry-run\]\s+5\. DELETE/.test(r.out) && /recall skipped/.test(r.out));
  await stub.close();
}

process.exitCode = fails ? 1 : 0;
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
