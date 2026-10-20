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
import { spawn, spawnSync } from "node:child_process";
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
const envFileLib = await import(pathToFileURL(path.join(ROOT, "providers/cognee/lib/env-file.mjs")).href);
const stackEnvLib = await import(pathToFileURL(path.join(ROOT, "providers/cognee/lib/stack-env.mjs")).href);
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
    if (/^(PM_COGNEE_|COGNEE_)/.test(k) || k === "LLM_API_KEY" || k === "EMBEDDING_API_KEY" || k === "WIZARD_SKIP_BACKEND_STEP") {
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
for (const phase of ["init", "hydrate", "resolvePorts", "configureModelRouting", "stackEnv", "beforeStack", "smoke", "extendValidation", "configToml", "summary", "clackSetup", "setupCodingAgent"]) {
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

// resolvePorts restores the saved port (hydrate runs after the ports are resolved).
/** @param {string} home @param {string} [stackEnv] */
function seedPortState(home, stackEnv) {
  fs.mkdirSync(path.join(home, ".config/hindsight"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config/hindsight/wizard.conf"), "MEMORY_PROVIDER=cognee\nCOGNEE_PORT=18777\n");
  if (stackEnv !== undefined) {
    fs.mkdirSync(path.join(home, "stack"), { recursive: true });
    fs.writeFileSync(path.join(home, "stack/.env"), stackEnv);
  }
}
for (const [label, vars, stackEnv, want] of /** @type {[string, Record<string,string>, string|undefined, string][]} */ ([
  ["wizard.conf supplies the port when env and .env have none", {}, undefined, "18777"],
  ["the stack .env beats wizard.conf", {}, "COGNEE_PORT=18555\n", "18555"],
  ["the environment beats wizard.conf", { COGNEE_PORT: "18999" }, undefined, "18999"],
  ["a .env without COGNEE_PORT still falls back to wizard.conf", {}, "HOST_UID=1\n", "18777"],
])) {
  await withEnv(vars, async () => {
    const home = tmp("restore");
    seedPortState(home, stackEnv);
    /** @type {string[]} */
    const seen = [];
    const { h } = makeHelpers({
      resolveHostPort: async () => {
        seen.push(String(process.env.COGNEE_PORT));
        return Number(process.env.COGNEE_PORT || stackEnv?.match(/COGNEE_PORT=(\d+)/)?.[1] || 8766);
      },
    });
    const ctx = makeCtx(home);
    await wiz.init(ctx, h);
    await wiz.resolvePorts(ctx, h);
    // Only the wizard.conf cases show the port in the environment before resolveHostPort runs.
    const sawBefore = seen[0];
    check(`resolvePorts: ${label}`, ctx.portCognee === want && (stackEnv?.includes("COGNEE_PORT") ? true : sawBefore === want), `${sawBefore} ${ctx.portCognee}`);
  });
}
await withEnv({}, async () => {
  const home = tmp("hydrate");
  seedPortState(home);
  const { h } = makeHelpers();
  const ctx = makeCtx(home);
  await wiz.hydrate(ctx, h);
  check("hydrate: is a quiet no-op that leaves the environment alone", process.env.COGNEE_PORT === undefined && ctx.cognee !== undefined);
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
  check("llm: mentions auth is pinned off in compose", /ENABLE_BACKEND_ACCESS_CONTROL/.test(text()) && /REQUIRE_AUTHENTICATION=true/.test(text()) && /cognee-indexer\.env/.test(text()));
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
  const { h, lines, text } = makeHelpers({ saveWizardConf: () => {} });
  const ctx = makeCtx(home);
  await wiz.init(ctx, h);
  await wiz.configureModelRouting(ctx, h);
  const body = fs.readFileSync(envFileOf(home), "utf8");
  check(
    "llm: ollama preset writes key, bare endpoint, and matching embeddings",
    body.includes("LLM_PROVIDER=ollama\n") &&
      body.includes("LLM_MODEL=local-model\n") &&
      body.includes("LLM_API_KEY=ollama\n") &&
      body.includes("LLM_ENDPOINT=http://host.docker.internal:11434\n") &&
      !body.includes("/v1") &&
      body.includes("EMBEDDING_PROVIDER=ollama\n") &&
      body.includes("EMBEDDING_MODEL=nomic-embed-text:latest\n") &&
      body.includes("EMBEDDING_ENDPOINT=http://host.docker.internal:11434/api/embed\n") &&
      body.includes("EMBEDDING_DIMENSIONS=768\n"),
    body,
  );
  check("llm: ollama preset is cognify-ready (no missing-key warning)", !lines.some((l) => l.kind === "warn" && /not searchable/.test(l.msg)), text());
});
await withEnv({ PM_COGNEE_LLM_PROVIDER: "ollama", PM_COGNEE_EMBEDDING_PROVIDER: "openai" }, async () => {
  const home = tmp("llm-mismatch");
  const { h, lines } = makeHelpers({ saveWizardConf: () => {} });
  const ctx = makeCtx(home);
  await wiz.init(ctx, h);
  await wiz.configureModelRouting(ctx, h);
  check(
    "llm: warns when LLM and embedding providers disagree",
    lines.some((l) => l.kind === "warn" && /LLM_PROVIDER=ollama but EMBEDDING_PROVIDER=openai/.test(l.msg)),
  );
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
  const { h, text, lines } = makeHelpers({
    saveWizardConf: () => {},
    ask: async (_c, prompt) => {
      prompts.push(prompt);
      return SECRET;
    },
  });
  const ctx = makeCtx(home, { yes: false });
  await wiz.init(ctx, h);
  await wiz.configureModelRouting(ctx, h);
  check("llm: interactive run never calls helpers.ask for the key (it echoes)", prompts.length === 0);
  check(
    "llm: ... and prints put-in-file instructions instead",
    lines.some((l) => l.kind === "info" && /put LLM_API_KEY=/.test(l.msg) && /mode 600/.test(l.msg)),
    text(),
  );
  check("llm: no env file without a key or Clack hand-off", !fs.existsSync(envFileOf(home)));
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
  fs.writeFileSync(path.join(dir, "cognee-indexer.env"), "COGNEE_API_KEY=y\n", { mode: 0o644 });
  fs.chmodSync(path.join(dir, "cognee-indexer.env"), 0o644);
  const dry = makeHelpers();
  await wiz.beforeStack({ ...ctx, dry: true }, dry.h);
  check("beforeStack: dry run only warns about a group-readable cognee.env", dry.lines.some((l) => l.kind === "warn" && /cognee\.env/.test(l.msg)) && mode(path.join(dir, "cognee.env")) === "640");
  const second = makeHelpers();
  await wiz.beforeStack(ctx, second.h);
  check("beforeStack: a real run tightens cognee.env and the indexer env file to 600", mode(path.join(dir, "cognee.env")) === "600" && mode(path.join(dir, "cognee-indexer.env")) === "600");
  check("beforeStack: ... says so without printing contents", second.lines.some((l) => l.kind === "ok" && /tightened .*cognee\.env/.test(l.msg)) && !second.text().includes("LLM_API_KEY=x"));
  check("beforeStack: the default location raises no 'unmasked' warning", !second.lines.some((l) => /outside ~\/\.config\/personal-memory/.test(l.msg)));
});
await withEnv({}, async () => {
  const home = tmp("before-custom");
  process.env.COGNEE_ENV_FILE = path.join(home, "vault/cognee.env");
  const { h, lines } = makeHelpers();
  const ctx = makeCtx(home);
  await wiz.init(ctx, h);
  await wiz.beforeStack(ctx, h);
  check("beforeStack: an env file under $HOME but outside ~/.config/personal-memory is flagged as unmasked", lines.some((l) => l.kind === "warn" && /outside ~\/\.config\/personal-memory/.test(l.msg) && l.msg.includes(path.join(home, "vault/cognee.env"))));
  check("beforeStack: ... and its directory is created with mode 700", mode(path.join(home, "vault")) === "700");
});
await withEnv({ COGNEE_ENV_FILE: "/opt/pm-elsewhere/cognee.env" }, async () => {
  const home = tmp("before-outside");
  const { h, lines } = makeHelpers();
  const ctx = makeCtx(home);
  await wiz.init(ctx, h);
  await wiz.beforeStack({ ...ctx, dry: true }, h);
  check("beforeStack: an env file outside $HOME is not flagged", !lines.some((l) => /outside ~\/\.config\/personal-memory/.test(l.msg)));
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
  check("summary: notes cover cognify config, graph status, first start, delete and REST agents", /cognify-ready|LLM_API_KEY|Ollama/.test(all) && /api\/v1\/datasets\/status/.test(all) && /large image/.test(all) && /graph and vectors/.test(all) && /REST API/.test(all));
  check("summary: no secret text", !all.includes("COGNEE_API_KEY=k"));
  check("summary: log services", s.logServices.join() === "cognee,indexer");
});

// setupCodingAgent.
await withEnv({}, async () => {
  const home = tmp("coding-agent");
  const { h, text } = makeHelpers();
  const ctx = makeCtx(home);
  await wiz.init(ctx, h);
  ctx.portCognee = "18999";
  ctx.cogneeUrl = "http://127.0.0.1:18999";
  await wiz.setupCodingAgent(ctx, h);
  check(
    "setupCodingAgent: prints REST paths, no plugin package",
    /no coding-agent plugin/.test(text()) &&
      /\/docs/.test(text()) &&
      /\/api\/v1\/add/.test(text()) &&
      /\/api\/v1\/cognify/.test(text()) &&
      /\/api\/v1\/search/.test(text()) &&
      !/npx/.test(text()),
    text(),
  );
});

// clackSetup.
await withEnv({}, async () => {
  const home = tmp("clack");
  const { h } = makeHelpers();
  /** @type {string[]} */
  const asked = [];
  /** @type {string[]} */
  const choices = [];
  const ui = {
    select: async ({ message }) => (choices.push(message), "openai"),
    password: async ({ message }) => (asked.push(message), `  ${SECRET} `),
    confirm: async () => true,
    isCancel: () => false,
    cancel: () => {},
    log: { info: () => {}, warn: () => {} },
  };
  const handoff = await wiz.clackSetup({ repoRoot: path.join(home, "stack"), home, pmMerged: {} }, ui, h);
  check("clackSetup: offers OpenAI vs Ollama then a hidden password prompt", choices.length === 1 && /Ollama|LLM/.test(choices[0]) && asked.length === 1 && /hidden/.test(asked[0]));
  check("clackSetup: hands the key over as PM_COGNEE_LLM_API_KEY and skips the wizard's own step", handoff.PM_COGNEE_LLM_API_KEY === SECRET && handoff.WIZARD_SKIP_BACKEND_STEP === "1");
  const empty = await wiz.clackSetup({ repoRoot: home, home, pmMerged: {} }, { ...ui, password: async () => "" }, h);
  check("clackSetup: an empty answer hands over no key", empty.PM_COGNEE_LLM_API_KEY === undefined && empty.WIZARD_SKIP_BACKEND_STEP === "1");
  const ollamaUi = { ...ui, select: async () => "ollama" };
  const ollama = await wiz.clackSetup({ repoRoot: home, home, pmMerged: {} }, ollamaUi, h);
  check(
    "clackSetup: Ollama choice hands over provider + embeddings (no password)",
    ollama.PM_COGNEE_LLM_PROVIDER === "ollama" &&
      ollama.PM_COGNEE_LLM_API_KEY === "ollama" &&
      ollama.PM_COGNEE_LLM_ENDPOINT === "http://host.docker.internal:11434" &&
      ollama.PM_COGNEE_EMBEDDING_PROVIDER === "ollama" &&
      ollama.PM_COGNEE_EMBEDDING_ENDPOINT === "http://host.docker.internal:11434/api/embed" &&
      ollama.WIZARD_SKIP_BACKEND_STEP === "1",
  );
  fs.mkdirSync(path.join(home, ".config/personal-memory"), { recursive: true });
  fs.writeFileSync(envFileOf(home), `LLM_API_KEY=${SECRET}\n`);
  /** @type {string[]} */
  const passwordCalls = [];
  const kept = await wiz.clackSetup({ repoRoot: home, home, pmMerged: {} }, { ...ui, confirm: async () => false, password: async () => (passwordCalls.push("x"), "new") }, h);
  check("clackSetup: an existing key is kept unless the user replaces it", passwordCalls.length === 0 && kept.PM_COGNEE_LLM_API_KEY === undefined);
});

// B1/B2: secrets leave process.env in `init`, before any child process can inherit them.
const SECRET_VARS = ["PM_COGNEE_LLM_API_KEY", "PM_COGNEE_EMBEDDING_API_KEY", "LLM_API_KEY", "EMBEDDING_API_KEY", "COGNEE_API_KEY"];
await withEnv({ PM_COGNEE_LLM_API_KEY: "pm-llm-secret", PM_COGNEE_EMBEDDING_API_KEY: "pm-emb-secret", LLM_API_KEY: "plain-llm-secret", EMBEDDING_API_KEY: "plain-emb-secret", COGNEE_API_KEY: "cognee-env-secret" }, async () => {
  const home = tmp("b1-yes");
  const { h, text } = makeHelpers({ saveWizardConf: () => {} });
  const ctx = makeCtx(home);
  await wiz.init(ctx, h);
  check("init: no secret variable is left in process.env (--yes)", SECRET_VARS.every((k) => process.env[k] === undefined));
  check("init: the secrets are not stored on ctx", !JSON.stringify(ctx).match(/secret/));
  await wiz.configureModelRouting(ctx, h);
  const body = fs.readFileSync(envFileOf(home), "utf8");
  check("llm: PM_COGNEE_* beats the plain variable and both keys are written", body.includes("LLM_API_KEY=pm-llm-secret\n") && body.includes("EMBEDDING_API_KEY=pm-emb-secret\n") && !body.includes("plain-"));
  check("llm: no secret is printed", !/-secret/.test(text()));
});
await withEnv({ LLM_API_KEY: "plain-llm-secret", EMBEDDING_API_KEY: "plain-emb-secret" }, async () => {
  const home = tmp("b1-plain");
  const { h } = makeHelpers({ saveWizardConf: () => {} });
  const ctx = makeCtx(home);
  await wiz.init(ctx, h);
  await wiz.configureModelRouting(ctx, h);
  check("--yes: plain LLM_API_KEY and EMBEDDING_API_KEY are consumed and removed from the environment", process.env.LLM_API_KEY === undefined && process.env.EMBEDDING_API_KEY === undefined && fs.readFileSync(envFileOf(home), "utf8") === "LLM_API_KEY=plain-llm-secret\nEMBEDDING_API_KEY=plain-emb-secret\n");
});
await withEnv({ LLM_API_KEY: "plain-llm-secret" }, async () => {
  const home = tmp("b1-dry");
  const { h } = makeHelpers();
  const ctx = makeCtx(home, { yes: false, dry: true });
  await wiz.init(ctx, h);
  check("--dry-run: plain LLM_API_KEY is also taken out of the environment", process.env.LLM_API_KEY === undefined);
});
await withEnv({ LLM_API_KEY: "plain-llm-secret", PM_COGNEE_LLM_API_KEY: "hand-off-secret" }, async () => {
  const home = tmp("b1-clack");
  const { h } = makeHelpers({ saveWizardConf: () => {} });
  const ctx = makeCtx(home, { yes: false, skipBackendStep: true });
  await wiz.init(ctx, h);
  await wiz.configureModelRouting(ctx, h);
  check("Clack hand-off: PM_COGNEE_LLM_API_KEY is taken and used", process.env.PM_COGNEE_LLM_API_KEY === undefined && fs.readFileSync(envFileOf(home), "utf8") === "LLM_API_KEY=hand-off-secret\n");
  check("Clack hand-off: plain LLM_API_KEY is scrubbed (not left for children)", process.env.LLM_API_KEY === undefined);
});
await withEnv({ LLM_API_KEY: "plain-llm-secret" }, async () => {
  const home = tmp("b1-keep");
  const file = envFileOf(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "LLM_API_KEY=stored-secret\n", { mode: 0o600 });
  const { h, lines } = makeHelpers({ saveWizardConf: () => {} });
  const ctx = makeCtx(home, { yes: false, skipBackendStep: true });
  await wiz.init(ctx, h);
  await wiz.configureModelRouting(ctx, h);
  check("Clack 'keep existing key': a plain LLM_API_KEY in the environment does not replace it", fs.readFileSync(file, "utf8") === "LLM_API_KEY=stored-secret\n" && !lines.some((l) => l.kind === "warn") && process.env.LLM_API_KEY === undefined);
});
await withEnv({ LLM_API_KEY: "plain-llm-secret" }, async () => {
  const home = tmp("b1-noplain");
  const { h, lines } = makeHelpers({ saveWizardConf: () => {} });
  const ctx = makeCtx(home, { yes: false, skipBackendStep: true });
  await wiz.init(ctx, h);
  await wiz.configureModelRouting(ctx, h);
  check("skipBackendStep alone never reads the plain LLM_API_KEY", !fs.existsSync(envFileOf(home)) && lines.some((l) => l.kind === "warn") && process.env.LLM_API_KEY === undefined);
});

// Escapes: a second run changes nothing for a value that needed quoting.
await withEnv({ PM_COGNEE_LLM_API_KEY: 'p"w$d\\' }, async () => {
  const home = tmp("escape");
  const { h } = makeHelpers({ saveWizardConf: () => {} });
  const ctx = makeCtx(home);
  await wiz.init(ctx, h);
  await wiz.configureModelRouting(ctx, h);
  const file = envFileOf(home);
  const first = fs.readFileSync(file);
  process.env.PM_COGNEE_LLM_API_KEY = 'p"w$d\\';
  const again = makeHelpers({ saveWizardConf: () => {} });
  await wiz.configureModelRouting(ctx, again.h);
  check("a value with quote, dollar and trailing backslash is written double-quoted", first.toString() === 'LLM_API_KEY="p\\"w\\$d\\\\"\n');
  check("... and a second run leaves it byte for byte unchanged", Buffer.compare(first, fs.readFileSync(file)) === 0 && /kept /.test(again.text()) && !/wrote /.test(again.text()));
});

// env-file helpers.
{
  const { parseEnvText, mergeEnvText, formatValue, writePrivateFile, writeTarget } = envFileLib;
  const values = parseEnvText("export A=1\r\nB='two words'\r\n# C=3\r\nD=\"q\\\"x\\\\y\\$z\"\r\n\r\nE = spaced\r\n");
  check("parseEnvText: export prefix, CRLF, quotes and double-quote unescaping", values.get("A") === "1" && values.get("B") === "two words" && !values.has("C") && values.get("D") === 'q"x\\y$z' && values.get("E") === "spaced");
  check("formatValue: a trailing backslash is never single-quoted", formatValue("abc\\").startsWith('"') && formatValue("abc\\") === '"abc\\\\"');
  check("formatValue: safe, spaced and quoted shapes", formatValue("sk-abc_1.2") === "sk-abc_1.2" && formatValue("a b") === "'a b'" && formatValue("it's") === '"it\'s"');
  let threw = false;
  try {
    formatValue("a\nLLM_API_KEY=evil");
  } catch {
    threw = true;
  }
  check("formatValue: a multi-line value is refused", threw);
  const merged = mergeEnvText("# LLM_API_KEY=commented\r\nNOTE=\"LLM_API_KEY=inside text\"\r\nexport LLM_API_KEY=old\r\nKEEP=1\r\n", { LLM_API_KEY: "new" });
  const parsed = parseEnvText(merged);
  check("mergeEnvText: replaces only the assignment (not a comment or a quoted mention), keeps CRLF-file neighbours", parsed.get("LLM_API_KEY") === "new" && parsed.get("NOTE") === "LLM_API_KEY=inside text" && parsed.get("KEEP") === "1" && merged.includes("# LLM_API_KEY=commented") && merged.split("LLM_API_KEY=new").length === 2);
  check("mergeEnvText: merging the same value again is a fixed point", mergeEnvText(merged, { LLM_API_KEY: "new" }) === merged);
  let badKey = false;
  try {
    mergeEnvText("", { "bad key": "x" });
  } catch {
    badKey = true;
  }
  check("mergeEnvText: an invalid key name is refused", badKey);

  // Symlinks keep their target.
  const dir = tmp("symlink");
  const real = path.join(dir, "dotfiles/cognee.env");
  fs.mkdirSync(path.dirname(real));
  fs.writeFileSync(real, "OLD=1\n", { mode: 0o644 });
  const link = path.join(dir, "cognee.env");
  fs.symlinkSync(real, link);
  writePrivateFile(link, "NEW=1\n");
  check("writePrivateFile: a symlinked env file stays a symlink to its target", fs.lstatSync(link).isSymbolicLink() && fs.readlinkSync(link) === real && fs.readFileSync(real, "utf8") === "NEW=1\n" && mode(real) === "600");
  check("writePrivateFile: no temp file is left beside the target", fs.readdirSync(path.dirname(real)).join() === "cognee.env" && fs.readdirSync(dir).sort().join() === "cognee.env,dotfiles");
  const dangling = path.join(dir, "dangling.env");
  fs.symlinkSync(path.join(dir, "dotfiles/later.env"), dangling);
  writePrivateFile(dangling, "X=1\n");
  check("writePrivateFile: a dangling symlink creates its target", fs.lstatSync(dangling).isSymbolicLink() && fs.readFileSync(path.join(dir, "dotfiles/later.env"), "utf8") === "X=1\n" && writeTarget(dangling) === path.join(dir, "dotfiles/later.env"));
}

// A symlinked cognee.env keeps its target through configureModelRouting.
await withEnv({ PM_COGNEE_LLM_API_KEY: SECRET }, async () => {
  const home = tmp("llm-symlink");
  const target = path.join(home, "dotfiles/cognee.env");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "FOO=bar\n", { mode: 0o644 });
  fs.mkdirSync(path.dirname(envFileOf(home)), { recursive: true });
  fs.symlinkSync(target, envFileOf(home));
  const { h } = makeHelpers({ saveWizardConf: () => {} });
  const ctx = makeCtx(home);
  await wiz.init(ctx, h);
  await wiz.configureModelRouting(ctx, h);
  check("llm: a dotfile-managed link keeps its target and the merge lands there", fs.lstatSync(envFileOf(home)).isSymbolicLink() && fs.readFileSync(target, "utf8") === `FOO=bar\nLLM_API_KEY=${SECRET}\n` && mode(target) === "600");
});

// Custom env file paths: precedence, persistence, expansion.
await withEnv({}, async () => {
  const home = tmp("paths");
  const stack = path.join(home, "stack");
  fs.mkdirSync(stack, { recursive: true });
  const { h } = makeHelpers();
  const mk = (/** @type {Record<string, any>} */ toml) => makeCtx(home, { pmMerged: { memory: { cognee: toml } } });
  const stackEnvFile = path.join(stack, ".env");
  let ctx = mk({});
  await wiz.init(ctx, h);
  check("paths: default locations with nothing set", ctx.cognee.envFile === envFileOf(home) && ctx.cognee.indexerEnvFile === path.join(home, ".config/personal-memory/cognee-indexer.env"));
  fs.writeFileSync(stackEnvFile, "COGNEE_ENV_FILE=/from/stack.env\nCOGNEE_INDEXER_ENV_FILE=/from/stack-indexer.env\n");
  ctx = mk({});
  await wiz.init(ctx, h);
  check("paths: the stack .env beats the default", ctx.cognee.envFile === "/from/stack.env" && ctx.cognee.indexerEnvFile === "/from/stack-indexer.env");
  ctx = mk({ env_file: "~/toml/cognee.env", indexer_env_file: "~/toml/indexer.env" });
  await wiz.init(ctx, h);
  check("paths: TOML beats the stack .env and ~ is expanded", ctx.cognee.envFile === path.join(home, "toml/cognee.env") && ctx.cognee.indexerEnvFile === path.join(home, "toml/indexer.env"));
  check("paths: TOML values are exported as absolute paths for compose", process.env.COGNEE_ENV_FILE === path.join(home, "toml/cognee.env") && process.env.COGNEE_INDEXER_ENV_FILE === path.join(home, "toml/indexer.env"));
  process.env.COGNEE_ENV_FILE = "~/env/cognee.env";
  process.env.COGNEE_INDEXER_ENV_FILE = "~/env/indexer.env";
  ctx = mk({ env_file: "~/toml/cognee.env", indexer_env_file: "~/toml/indexer.env" });
  await wiz.init(ctx, h);
  check("paths: the environment beats TOML, and ~ is expanded for both variables", ctx.cognee.envFile === path.join(home, "env/cognee.env") && ctx.cognee.indexerEnvFile === path.join(home, "env/indexer.env") && process.env.COGNEE_ENV_FILE === path.join(home, "env/cognee.env") && process.env.COGNEE_INDEXER_ENV_FILE === path.join(home, "env/indexer.env"));
  const toml = wiz.configToml(ctx).memory.cognee;
  check("configToml: persists env_file and indexer_env_file (home as ~)", toml.env_file === "~/env/cognee.env" && toml.indexer_env_file === "~/env/indexer.env");
  const se = wiz.stackEnv(ctx).env;
  check("stackEnv: passes custom env file paths to the stack setup script", se.COGNEE_ENV_FILE === path.join(home, "env/cognee.env") && se.COGNEE_INDEXER_ENV_FILE === path.join(home, "env/indexer.env"));
});
await withEnv({}, async () => {
  const home = tmp("paths-default");
  const { h } = makeHelpers();
  const ctx = makeCtx(home, { pmMerged: { memory: { cognee: { env_file: "~/.config/personal-memory/cognee.env", indexer_env_file: "~/.config/personal-memory/cognee-indexer.env" } } } });
  await wiz.init(ctx, h);
  check("paths: TOML values equal to the defaults are not exported and not passed on", process.env.COGNEE_ENV_FILE === undefined && process.env.COGNEE_INDEXER_ENV_FILE === undefined && !("COGNEE_ENV_FILE" in wiz.stackEnv(ctx).env));
  const toml = wiz.configToml(ctx).memory.cognee;
  check("configToml: defaults are written in ~ form", toml.env_file === "~/.config/personal-memory/cognee.env" && toml.indexer_env_file === "~/.config/personal-memory/cognee-indexer.env");
});
{
  const repo = tmp("prep-repo");
  const home = tmp("prep-home");
  const base = { repo, home };
  const plain = stackEnvLib.prepareStackEnv({ ...base, env: { PM_PACKAGE_ROOT: ROOT } });
  check("prepareStackEnv: no env file entries unless the environment names them", !plain.entries.some(([k]) => /ENV_FILE/.test(k)));
  const custom = stackEnvLib.prepareStackEnv({ ...base, env: { PM_PACKAGE_ROOT: ROOT, COGNEE_ENV_FILE: "~/secrets/cognee.env", COGNEE_INDEXER_ENV_FILE: "rel/indexer.env" } });
  const entries = Object.fromEntries(custom.entries);
  check("prepareStackEnv: writes absolute paths (~ expanded, relative to the stack root) and drops the old lines", entries.COGNEE_ENV_FILE === path.join(home, "secrets/cognee.env") && entries.COGNEE_INDEXER_ENV_FILE === path.join(repo, "rel/indexer.env") && custom.drop.includes("COGNEE_ENV_FILE") && custom.drop.includes("COGNEE_INDEXER_ENV_FILE"));
  check("prepareStackEnv: the reported line names paths, not contents", custom.report.some((r) => r.startsWith("COGNEE_ENV_FILE=")) && !custom.report.join().includes("API_KEY"));
  let threw = false;
  try {
    stackEnvLib.prepareStackEnv({ ...base, env: { PM_PACKAGE_ROOT: ROOT, COGNEE_ENV_FILE: "/x\nLLM_API_KEY=evil" } });
  } catch {
    threw = true;
  }
  check("prepareStackEnv: a multi-line path is refused", threw);
  const notice = stackEnvLib.setupNotices({ repo, home, env: { COGNEE_ENV_FILE: "~/secrets/cognee.env" } }).join("\n");
  check("setupNotices: names the expanded custom env file", notice.includes(path.join(home, "secrets/cognee.env")));
}

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
 * healthFailures, deleteStatus, requireKey, addDetail, createMode ("500-after-create" |
 * "hang-after-create"), metaStyle ("object" | "array" | "none" | "other").
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
    if (req.method === "GET" && url === "/api/v1/datasets") {
      return send(200, [...datasets.values()].map((d) => ({ id: d.id, name: d.name })));
    }
    if (req.method === "POST" && url === "/api/v1/datasets") {
      const { name } = JSON.parse(body.toString("utf8"));
      let ds = [...datasets.values()].find((d) => d.name === name);
      if (!ds) {
        ds = { id: crypto.randomUUID(), name, items: [] };
        datasets.set(ds.id, ds);
      }
      // The server did create the dataset but the client never learns it: 5xx, or no answer.
      if (opts.createMode === "500-after-create") return send(500, { detail: "gateway hiccup" });
      if (opts.createMode === "hang-after-create") return;
      return send(200, { id: ds.id, name: ds.name });
    }
    if (req.method === "POST" && url === "/api/v1/add") {
      if (opts.addStatus) return send(opts.addStatus, { detail: opts.addDetail ?? "ingest exploded" });
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
  const KEY = "cognee-key-from-file";
  const r = await smokeScenario({ requireKey: KEY }, { env: { COGNEE_API_KEY: "from-env-ignored" }, indexerEnv: `COGNEE_API_KEY=${KEY}\n` });
  check("smoke: indexer env file wins over a captured COGNEE_API_KEY", r.threw === "" && r.stub.requests.every((q) => q.headers["x-api-key"] === KEY) && process.env.COGNEE_API_KEY === undefined);
}
{
  const KEY = "cognee-key-captured-only";
  const r = await smokeScenario({ requireKey: KEY }, { env: { COGNEE_API_KEY: KEY } });
  check("smoke: captured COGNEE_API_KEY is used when the indexer file is absent", r.threw === "" && r.stub.requests.every((q) => q.headers["x-api-key"] === KEY) && process.env.COGNEE_API_KEY === undefined);
}
{
  const KEY = "cognee-secret-in-detail";
  const r = await smokeScenario({ requireKey: KEY, addStatus: 500, addDetail: `auth failed for ${KEY}` }, { env: { COGNEE_API_KEY: KEY } });
  check("smoke: redacts COGNEE_API_KEY from server detail in errors", /add failed/.test(r.threw) && !r.threw.includes(KEY) && /\*\*\*/.test(r.threw), r.threw);
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

{
  const r = await smokeScenario({ createMode: "500-after-create" });
  check("smoke: a create that answers 5xx after creating is found by name and deleted", /create dataset failed \(HTTP 500: gateway hiccup\)/.test(r.threw) && r.stub.datasets.size === 0 && r.stub.requests.some((q) => q.method === "GET" && q.url === "/api/v1/datasets"), r.threw);
}
{
  const r = await smokeScenario({ createMode: "hang-after-create" }, { timing: { requestTimeoutMs: 150 } });
  check("smoke: a create that times out is found by name and deleted", /create dataset request failed \(TimeoutError\)/.test(r.threw) && r.stub.datasets.size === 0 && r.stub.requests.at(-1)?.method === "DELETE", r.threw);
}
{
  const r = await smokeScenario({ requireKey: "k" }, { indexerEnv: "COGNEE_API_KEY=k\n" });
  check("smoke: a definite create answer (not 5xx) does not trigger the by-name lookup", !r.stub.requests.some((q) => q.method === "GET" && q.url === "/api/v1/datasets"));
}
{
  const detail = `boom\u0007\u001b[31m${"x".repeat(200)}`;
  const r = await smokeScenario({ addStatus: 500, addDetail: detail });
  const echoed = /HTTP 500: ([^)]*)\)/.exec(r.threw)?.[1] || "";
  check("smoke: the echoed server detail is at most 80 printable characters", echoed.length > 0 && echoed.length <= 80 && !/[\u0000-\u001f\u007f]/.test(r.threw), r.threw);
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
  check("validate: LLM_API_KEY assignment in the stack .env is an error", v.errors.some((e) => /repo \.env must not contain/.test(e)) && !v.errors.join().includes("oops"));
}
{
  const v = await validation((_h, ctx) => fs.appendFileSync(path.join(ctx.repoRoot, ".env"), "COGNEE_API_KEY=oops\n"));
  check("validate: COGNEE_API_KEY assignment in the stack .env is an error", v.errors.some((e) => /repo \.env must not contain/.test(e)));
}
{
  const v = await validation((_h, ctx) => fs.appendFileSync(path.join(ctx.repoRoot, ".env"), "HINDSIGHT_API_LLM_API_KEY=leftover\n"));
  check("validate: HINDSIGHT_API_LLM_API_KEY does not false-positive as a Cognee secret", !v.errors.some((e) => /repo \.env must not contain/.test(e)));
}
{
  const v = await validation((_h, ctx) => {
    fs.writeFileSync(
      ctx.cognee.envFile,
      "LLM_PROVIDER=ollama\nLLM_API_KEY=ollama\nLLM_ENDPOINT=http://host.docker.internal:11434\nEMBEDDING_PROVIDER=ollama\nEMBEDDING_MODEL=nomic-embed-text:latest\nEMBEDDING_ENDPOINT=http://host.docker.internal:11434/api/embed\nEMBEDDING_DIMENSIONS=768\n",
      { mode: 0o600 },
    );
  });
  check("validate: ollama + embeddings is cognify-ready", v.errors.length === 0 && v.checks.some((c) => /cognify-ready \(ollama/.test(c)), JSON.stringify(v));
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
env >> "\${STUB_LOG}.env"
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
 * @param {Record<string, string | null>} [over] environment overrides (null removes a variable)
 * @returns {Promise<{ code: number | null, out: string }>}
 */
function runWizard(w, port, args, over = {}) {
  return new Promise((resolve) => {
    const env = {
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
      ...(port ? { COGNEE_PORT: String(port) } : {}),
      PM_COGNEE_LLM_API_KEY: SECRET,
      PM_COGNEE_LLM_MODEL: "test-model",
      ...over,
    };
    // A null override removes the variable.
    for (const [k, v] of Object.entries(env)) if (v === null) delete env[k];
    const child = spawn(process.execPath, [path.join(ROOT, "wizard/bin/setup.mjs"), ...args], {
      cwd: w.base,
      stdio: ["ignore", "pipe", "pipe"],
      env,
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
  const stackTreeBefore = tree(w.stack);
  const envBefore = fs.readFileSync(path.join(w.stack, ".env"), "utf8");
  stub.requests.length = 0;
  const again = await runWizard(w, stub.port, ["--yes"]);
  check("real run: a second run exits 0", again.code === 0, again.out.split("\n").slice(-15).join("\n"));
  if (process.env.COGNEE_TEST_VERBOSE) {
    const now = new Set(tree(w.stack));
    console.log("stack changes:", stackTreeBefore.filter((l) => !now.has(l)));
    console.log("env before:\n" + envBefore + "env after:\n" + fs.readFileSync(path.join(w.stack, ".env"), "utf8"));
    const homeNow = new Set(tree(w.home));
    console.log("home changes:", before.filter((l) => !homeNow.has(l)));
  }
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
  check("no key: summary tells the operator what to set", /Cognee needs a cognify-ready LLM config/.test(out));
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

// ---------------------------------------------------------------------------
// env files round-trip through real Docker Compose
// ---------------------------------------------------------------------------
console.log("--- env-file round trip (docker compose config)");
{
  const composeOk = spawnSync("docker", ["compose", "version", "--short"], { encoding: "utf8" });
  const major = Number(/^v?(\d+)/.exec(composeOk.stdout || "")?.[1] || 0);
  if (composeOk.status !== 0 || major < 2) {
    console.log("skip  docker compose is unavailable: round-trip tests skipped");
  } else {
    const dir = tmp("roundtrip");
    fs.writeFileSync(path.join(dir, "compose.yaml"), "services:\n  t:\n    image: scratch-never-pulled\n    env_file: [./t.env]\n");
    const values = [
      "sk-plain_123", "a=b=c", "a#b", "a b  c", "  lead and trail  ", "a$b${C}d", 'say "hi"', "it's", "it's \"x\" $y",
      "a`b`", "abc\\", "a\\b", "abc \\", 'a"b\\', "p@ss:w0rd/+%", "trailing\\\\", "$$", "\\$HOME", "q'\\", "tab\there",
    ];
    const updates = Object.fromEntries(values.map((v, i) => [`V${i}`, v]));
    const text = envFileLib.mergeEnvText("# header\nKEEP=1\n", updates);
    fs.writeFileSync(path.join(dir, "t.env"), text);
    const r = spawnSync("docker", ["compose", "-p", "pm-cognee-roundtrip", "-f", "compose.yaml", "config", "--format", "json"], { cwd: dir, encoding: "utf8" });
    check("round trip: Compose accepts the env file we wrote", r.status === 0, r.stderr);
    if (r.status === 0) {
      const environment = JSON.parse(r.stdout).services.t.environment;
      for (const [i, v] of values.entries()) {
        // `config` prints a literal $ as $$ (it re-escapes for interpolation); undo that.
        const got = String(environment[`V${i}`]).replaceAll("$$", "$");
        check(`round trip: Compose reads back ${JSON.stringify(v)}`, got === v, JSON.stringify(got));
      }
      check("round trip: the unrelated line survives", environment.KEEP === "1");
      const reparsed = envFileLib.parseEnvText(text);
      check("round trip: our own parser agrees with what we wrote", values.every((v, i) => reparsed.get(`V${i}`) === v));
      check("round trip: merging the same values again changes nothing", envFileLib.mergeEnvText(text, updates) === text);
    }
  }
}

// ---------------------------------------------------------------------------
// (c2) --up, --down, and the child environment
// ---------------------------------------------------------------------------
console.log("--- (c2) --up, --down, child environment");

/** Secrets must not reach a child process: the fake docker dumps its environment on every call. */
async function childEnvScenario(label, args, over, secrets, wantFile) {
  const stub = await startCognee({});
  const w = makeWorld(`childenv-${label}`);
  const homeBefore = JSON.stringify(tree(w.home));
  const r = await runWizard(w, stub.port, args, over);
  const envLog = fs.existsSync(`${w.log}.env`) ? fs.readFileSync(`${w.log}.env`, "utf8") : "";
  check(`child env (${label}): the wizard exits 0`, r.code === 0, r.out.split("\n").slice(-12).join("\n"));
  check(`child env (${label}): the fake docker was called and dumped a real environment`, /PM_PROJECT=pm-cognee-test/.test(envLog) && (envLog.match(/^PATH=/gm) || []).length >= 3);
  check(`child env (${label}): no secret appears in any docker call's environment`, secrets.every((x) => !envLog.includes(x)), secrets.filter((x) => envLog.includes(x)).join());
  check(`child env (${label}): no secret in the wizard output`, secrets.every((x) => !r.out.includes(x)));
  if (wantFile) {
    check(`child env (${label}): the key reached cognee.env`, fs.existsSync(envFileOf(w.home)) && fs.readFileSync(envFileOf(w.home), "utf8").includes(wantFile));
  } else {
    check(`child env (${label}): nothing was written under --dry-run`, JSON.stringify(tree(w.home)) === homeBefore && stub.requests.length === 0);
  }
  await stub.close();
}
await childEnvScenario("yes-plain", ["--yes"], { PM_COGNEE_LLM_API_KEY: null, LLM_API_KEY: "plain-llm-child-secret", EMBEDDING_API_KEY: "plain-emb-child-secret", PM_COGNEE_EMBEDDING_API_KEY: null }, ["plain-llm-child-secret", "plain-emb-child-secret"], "LLM_API_KEY=plain-llm-child-secret");
await childEnvScenario("yes-pm", ["--yes"], { PM_COGNEE_LLM_API_KEY: "pm-llm-child-secret", PM_COGNEE_EMBEDDING_API_KEY: "pm-emb-child-secret" }, ["pm-llm-child-secret", "pm-emb-child-secret"], "EMBEDDING_API_KEY=pm-emb-child-secret");
await childEnvScenario("dry-run", ["--yes", "--dry-run"], { PM_COGNEE_LLM_API_KEY: "dry-llm-child-secret", LLM_API_KEY: "dry-plain-child-secret" }, ["dry-llm-child-secret", "dry-plain-child-secret"], "");
await childEnvScenario("clack-handoff", [], { WIZARD_SKIP_BACKEND_STEP: "1", PM_COGNEE_LLM_API_KEY: "clack-llm-child-secret" }, ["clack-llm-child-secret"], "LLM_API_KEY=clack-llm-child-secret");

{
  // --up: a second start from the saved state. No port in the environment, no stack .env, no
  // config.toml: the port comes back from wizard.conf.
  const stub = await startCognee({});
  const w = makeWorld("up");
  const first = await runWizard(w, stub.port, ["--yes"]);
  check("--up: the configure run before it exits 0", first.code === 0, first.out.split("\n").slice(-8).join("\n"));
  const confBefore = fs.readFileSync(path.join(w.home, ".config/hindsight/wizard.conf"), "utf8");
  fs.rmSync(path.join(w.stack, ".env"));
  fs.rmSync(path.join(w.home, ".config/personal-memory/config.toml"));
  fs.rmSync(w.log);
  stub.requests.length = 0;
  const up = await runWizard(w, null, ["--up", "--yes"], { PM_COGNEE_LLM_API_KEY: null, PM_COGNEE_LLM_MODEL: null });
  check("--up: exits 0", up.code === 0, up.out.split("\n").slice(-20).join("\n"));
  const log = fs.existsSync(w.log) ? fs.readFileSync(w.log, "utf8") : "";
  check("--up: runs compose up with the profile and files", /compose -p pm-cognee-test -f compose\.yaml( -f compose\.override\.yaml)? -f providers\/cognee\/compose\.yaml --profile cognee up -d/.test(log), log);
  const stackEnv = fs.readFileSync(path.join(w.stack, ".env"), "utf8");
  check("--up: the port saved in wizard.conf is restored into the stack .env", stackEnv.includes(`COGNEE_PORT=${stub.port}\n`), stackEnv);
  check("--up: the stub is smoke-tested on that port and left clean", stub.requests.some((q) => q.method === "POST" && q.url === "/api/v1/add") && stub.datasets.size === 0);
  check("--up: wizard.conf is not rewritten and cognee.env is untouched", fs.readFileSync(path.join(w.home, ".config/hindsight/wizard.conf"), "utf8") === confBefore && fs.readFileSync(envFileOf(w.home), "utf8").includes(SECRET));
  check("--up: the summary names the Cognee API", up.out.includes(`Cognee API         http://127.0.0.1:${stub.port}`));
  check("--up: nothing secret in the new stack .env", !/API_KEY|sk-/.test(stackEnv));
  stub.requests.length = 0;
  fs.rmSync(w.log);
  const down = await runWizard(w, stub.port, ["--down", "--yes"]);
  check("--down: exits 0", down.code === 0, down.out.split("\n").slice(-12).join("\n"));
  const downLog = fs.readFileSync(w.log, "utf8");
  check("--down: runs compose down with the profile and files, without -v", /compose -p pm-cognee-test -f compose\.yaml( -f compose\.override\.yaml)? -f providers\/cognee\/compose\.yaml --profile cognee down\n/.test(downLog) && !/ down -v/.test(downLog), downLog);
  check("--down: sends no request to Cognee and prints the summary", stub.requests.length === 0 && /== Summary ==/.test(down.out) && /Memory provider: Cognee/.test(down.out));
  check("--down: the secret is not printed", !down.out.includes(SECRET));
  await stub.close();
}

process.exitCode = fails ? 1 : 0;
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
