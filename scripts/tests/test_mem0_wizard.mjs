#!/usr/bin/env node
/**
 * mem0 sub-wizard tests: hooks with stubbed helpers, the smoke test against a node:http stub
 * that emulates the mem0 REST server, validation error cases, and a real ./setup run (the
 * wizard/bin/setup.mjs entry) against a scratch copy of the tree, a fake docker on PATH, a
 * scratch HOME and the same stub. Nothing here touches the operator's config or any real
 * stack: every path is under a temp dir and every URL is a loopback stub on an ephemeral port.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadManifest } from "../../wizard/lib/providers/registry.mjs";
import { createHelpers } from "../../wizard/lib/provider-wizard/helpers.mjs";
import { parseEnvValue } from "../../providers/mem0/lib/dotenv.mjs";
import { readKey, writeKey } from "../../providers/mem0/lib/env-file.mjs";
import { captureKeyFromEnv, capturedKey, clearCapturedKey } from "../../providers/mem0/lib/secret.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let fails = 0;
function check(desc, ok) {
  if (ok) console.log(`ok    ${desc}`);
  else {
    console.log(`FAIL  ${desc}`);
    fails++;
  }
}

const mem0 = await import(pathToFileURL(path.join(root, "providers/mem0/wizard.mjs")).href);
const manifest = loadManifest("mem0");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pm-mem0-"));
const KEY = "m0sk_test_KEY_0123456789";

const ENV_KEYS = [
  "MEM0_API_URL",
  "PM_MEM0_API_URL",
  "MEM0_API_KEY",
  "PM_MEM0_API_KEY",
  "MEM0_ENV_FILE",
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
function resetEnv(extra = {}) {
  clearCapturedKey();
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, extra);
}

/** Stubbed helpers: nothing exits, nothing prompts. `answers` maps a prompt substring to a reply. */
function stubHelpers({ answers = {} } = {}) {
  const out = [];
  const saved = [];
  const asked = [];
  const h = createHelpers({
    step: (m) => out.push(`step ${m}`),
    info: (m) => out.push(m),
    ok: (m) => out.push(`ok ${m}`),
    warn: (m) => out.push(`warn ${m}`),
    die: (m) => {
      throw new Error(`die: ${m}`);
    },
    problem: (ctx, m) => {
      if (ctx.dry) out.push(`warn ${m}`);
      else throw new Error(`die: ${m}`);
    },
    ask: async (_ctx, prompt, def) => {
      asked.push(prompt);
      const hit = Object.keys(answers).find((k) => prompt.includes(k));
      return hit ? answers[hit] : def;
    },
    saveWizardConf: (_ctx, extra, opts) => saved.push({ extra, opts }),
    loadMachineEnv: () => ({}),
  });
  return { h, out, saved, asked };
}

function freshCtx(name, extra = {}) {
  const home = path.join(tmp, name);
  const hs = path.join(home, ".config/hindsight");
  const repoRoot = path.join(home, "stack");
  fs.mkdirSync(hs, { recursive: true });
  fs.mkdirSync(repoRoot, { recursive: true });
  return {
    home,
    hsDir: hs,
    repoRoot,
    wizardConf: path.join(hs, "wizard.conf"),
    memoryProvider: manifest,
    yes: true,
    dry: false,
    action: "configure",
    ...extra,
  };
}

const envFileOf = (ctx) => path.join(ctx.home, ".config/personal-memory/mem0.env");
const modeOf = (p) => fs.statSync(p).mode & 0o777;
const text = (out) => out.join("\n");

async function dies(fn) {
  try {
    await fn();
  } catch (e) {
    return String(e.message);
  }
  return "";
}

// ---------------------------------------------------------------------------
// (a) hooks with stubbed helpers

// apiBase precedence: --api-url > MEM0_API_URL > PM_MEM0_API_URL > [memory.mem0] > stack .env > wizard.conf > default.
{
  resetEnv();
  const ctx = freshCtx("base");
  const { h } = stubHelpers();
  await mem0.init(ctx, h);
  check("apiBase default is the 18888 loopback URL (not Hindsight's 8888)", mem0.apiBase(ctx, h) === "http://127.0.0.1:18888");

  fs.writeFileSync(ctx.wizardConf, "MEMORY_PROVIDER=mem0\nMEM0_API_URL=http://conf.example:2/\n");
  check("apiBase: wizard.conf (trailing slash stripped)", mem0.apiBase(ctx, h) === "http://conf.example:2");

  fs.writeFileSync(path.join(ctx.repoRoot, ".env"), "HOST_UID=1\nMEM0_API_URL=http://stack.example:1\n");
  check("apiBase: stack .env beats wizard.conf", mem0.apiBase(ctx, h) === "http://stack.example:1");

  const tomlCtx = freshCtx("base-toml", { pmMerged: { memory: { mem0: { api_url: "http://toml.example:3/", env_file: "~/keys/mem0.env" } } } });
  fs.writeFileSync(path.join(tomlCtx.repoRoot, ".env"), "MEM0_API_URL=http://stack.example:1\n");
  await mem0.init(tomlCtx, h);
  check("init reads [memory.mem0] api_url and env_file", tomlCtx.mem0.apiUrl === "http://toml.example:3/" && tomlCtx.mem0.tomlEnvFile === "~/keys/mem0.env");
  check("apiBase: [memory.mem0] beats the stack .env", mem0.apiBase(tomlCtx, h) === "http://toml.example:3");

  resetEnv({ PM_MEM0_API_URL: "http://pm.example:4" });
  check("apiBase: PM_MEM0_API_URL beats [memory.mem0]", mem0.apiBase(tomlCtx, h) === "http://pm.example:4");
  resetEnv({ PM_MEM0_API_URL: "http://pm.example:4", MEM0_API_URL: "http://env.example:5" });
  check("apiBase: MEM0_API_URL beats PM_MEM0_API_URL", mem0.apiBase(tomlCtx, h) === "http://env.example:5");
  tomlCtx.apiUrl = "http://flag.example:6/";
  check("apiBase: ctx.apiUrl (--api-url) wins over everything", mem0.apiBase(tomlCtx, h) === "http://flag.example:6");

  // hydrate (for --up): restore the saved URL from wizard.conf.
  resetEnv();
  const upCtx = freshCtx("hydrate");
  fs.writeFileSync(upCtx.wizardConf, "MEMORY_PROVIDER=mem0\nMEM0_API_URL=http://saved.example:7\n");
  await mem0.hydrate(upCtx, h);
  check("hydrate restores MEM0_API_URL from wizard.conf", upCtx.mem0.savedUrl === "http://saved.example:7" && mem0.apiBase(upCtx, h) === "http://saved.example:7");
}

// configureModelRouting --yes with MEM0_API_KEY: file 0600 in a 0700 dir, key never printed or saved.
{
  resetEnv({ MEM0_API_URL: "http://127.0.0.1:19999", MEM0_API_KEY: KEY });
  const ctx = freshCtx("yes-key");
  const { h, out, saved, asked } = stubHelpers();
  await mem0.init(ctx, h);
  await mem0.configureModelRouting(ctx, h);
  const file = envFileOf(ctx);
  check("--yes + key: env file holds exactly MEM0_API_KEY=<key>", fs.readFileSync(file, "utf8") === `MEM0_API_KEY=${KEY}\n`);
  check("--yes + key: env file mode 600", modeOf(file) === 0o600);
  check("--yes + key: env file directory mode 700", modeOf(path.dirname(file)) === 0o700);
  check("--yes + key: no prompt", asked.length === 0);
  check("--yes + key: the key is in no output line", !text(out).includes(KEY));
  check("--yes + key: the file path is printed", text(out).includes(file));
  check(
    "--yes + key: wizard.conf extra is the URL only; no key anywhere in it",
    saved.length === 1 && saved[0].extra.MEM0_API_URL === "http://127.0.0.1:19999" && Object.keys(saved[0].extra).length === 1 && !JSON.stringify(saved).includes(KEY),
  );
  const sections = saved[0].opts.pmSections;
  check(
    "--yes + key: config.toml section is [memory.mem0] api_url only (the wizard sets provider)",
    sections.memory.mem0.api_url === "http://127.0.0.1:19999" && !("provider" in sections.memory) && !("api_key" in sections.memory.mem0),
  );
  check("--yes + key: the old throw is gone and the step is announced", text(out).includes("step 3. mem0 server URL and API key"));
  check("--yes + key: MEM0_API_URL exported for compose", process.env.MEM0_API_URL === "http://127.0.0.1:19999");

  // A second run with the same key leaves the file alone.
  const before = fs.statSync(file).mtimeMs;
  await mem0.configureModelRouting(ctx, h);
  check("rerun with the same key keeps the file (unchanged)", fs.statSync(file).mtimeMs === before && text(out).includes("same key"));
}

// Merge: other lines kept, the old key line replaced, a loose mode tightened.
{
  resetEnv({ MEM0_API_URL: "http://127.0.0.1:19999", MEM0_API_KEY: KEY });
  const ctx = freshCtx("merge");
  const file = envFileOf(ctx);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "# mine\nFOO=bar\nMEM0_API_KEY=old-key\nBAZ=1\n", { mode: 0o644 });
  const { h, out } = stubHelpers();
  await mem0.configureModelRouting(ctx, h);
  const body = fs.readFileSync(file, "utf8");
  check(
    "merge: other lines preserved, key replaced exactly once",
    body === `# mine\nFOO=bar\nBAZ=1\nMEM0_API_KEY=${KEY}\n` && !body.includes("old-key"),
  );
  check("merge: loose mode tightened to 600", modeOf(file) === 0o600);
  check("merge: neither key in the output", !text(out).includes(KEY) && !text(out).includes("old-key"));
}

// --yes without a key: no file, an info line, not an error.
{
  resetEnv({ MEM0_API_URL: "http://127.0.0.1:19999" });
  const ctx = freshCtx("yes-nokey");
  const { h, out, saved } = stubHelpers();
  await mem0.configureModelRouting(ctx, h);
  check("--yes without a key: no env file created", !fs.existsSync(envFileOf(ctx)));
  check("--yes without a key: info says auth-enabled servers need one", /auth enabled.*needs one/.test(text(out)) && text(out).includes("AUTH_DISABLED"));
  check("--yes without a key: not an error, conf still saved", saved.length === 1);
}

// An existing key is kept when none is supplied.
{
  resetEnv({ MEM0_API_URL: "http://127.0.0.1:19999" });
  const ctx = freshCtx("yes-existing");
  const file = envFileOf(ctx);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "MEM0_API_KEY=already-here\n", { mode: 0o600 });
  const { h, out } = stubHelpers();
  await mem0.configureModelRouting(ctx, h);
  check("existing key kept, file untouched", fs.readFileSync(file, "utf8") === "MEM0_API_KEY=already-here\n" && text(out).includes("kept the API key already"));
  check("existing key never printed", !text(out).includes("already-here"));
}

// Dry run: plan printed, nothing written (not even the directory).
{
  resetEnv({ MEM0_API_URL: "http://127.0.0.1:19999", MEM0_API_KEY: KEY });
  const ctx = freshCtx("dry", { dry: true });
  const { h, out, saved } = stubHelpers();
  await mem0.configureModelRouting(ctx, h);
  check("dry run: no env file and no directory", !fs.existsSync(path.dirname(envFileOf(ctx))));
  check("dry run: no wizard.conf save", saved.length === 0);
  check("dry run: plan lines printed, no key", text(out).includes("[dry-run] write MEM0_API_KEY to") && text(out).includes("[dry-run] record MEM0_API_URL") && !text(out).includes(KEY));
}

// Validation of the URL and the key (messages never echo them).
{
  resetEnv({ MEM0_API_URL: "http://user:hunter2@127.0.0.1:19999" });
  const { h } = stubHelpers();
  const msg = await dies(() => mem0.configureModelRouting(freshCtx("bad-url"), h));
  check("URL with credentials: dies with the indexerUrl rule, secret not echoed", /credentials/.test(msg) && !msg.includes("hunter2"));
  resetEnv({ MEM0_API_URL: "ftp://127.0.0.1:1" });
  check("non-http URL rejected", /http or https/.test(await dies(() => mem0.configureModelRouting(freshCtx("bad-url2"), h))));
  resetEnv({ MEM0_API_URL: "http://127.0.0.1:19999", MEM0_API_KEY: 'a b"c$d' });
  const keyMsg = await dies(() => mem0.configureModelRouting(freshCtx("bad-key"), h));
  check("unsafe key characters rejected without echoing the key", /cannot hold safely/.test(keyMsg) && !keyMsg.includes('a b"c$d'));
  const dryCtx = freshCtx("bad-url-dry", { dry: true });
  resetEnv({ MEM0_API_URL: "nope" });
  const dry = stubHelpers();
  await mem0.configureModelRouting(dryCtx, dry.h);
  check("dry run: an invalid URL is a warning, not a stop", text(dry.out).includes("warn mem0 API URL:") && dry.saved.length === 0);
}

// Interactive answers (not --yes): the URL is asked; the key is NOT (helpers.ask would echo it).
{
  resetEnv();
  const ctx = freshCtx("interactive", { yes: false });
  const { h, out, saved, asked } = stubHelpers({ answers: { "REST server URL": "http://mem0.internal:8000/" } });
  await mem0.configureModelRouting(ctx, h);
  check("interactive: only the URL is asked, never the key", asked.length === 1 && asked[0].includes("URL"));
  check("interactive: URL answer saved (trailing slash dropped)", saved[0]?.extra.MEM0_API_URL === "http://mem0.internal:8000");
  check("interactive: info points at the env file and the env variables", text(out).includes(envFileOf(ctx)) && text(out).includes("PM_MEM0_API_KEY") && !fs.existsSync(envFileOf(ctx)));
}

// skipBackendStep: the Clack hand-off (PM_MEM0_API_KEY) is consumed, nothing is asked.
{
  resetEnv({ MEM0_API_URL: "http://127.0.0.1:19999", PM_MEM0_API_KEY: KEY });
  const ctx = freshCtx("skip", { yes: false, skipBackendStep: true });
  const { h, out, asked } = stubHelpers();
  await mem0.configureModelRouting(ctx, h);
  check("skipBackendStep: nothing asked, key from the hand-off written", asked.length === 0 && fs.readFileSync(envFileOf(ctx), "utf8") === `MEM0_API_KEY=${KEY}\n`);
  check("skipBackendStep: hand-off variable removed from the environment", process.env.PM_MEM0_API_KEY === undefined);
  check("skipBackendStep: announced, key not printed", text(out).includes("setup UI") && !text(out).includes(KEY));
}

// TOML env_file and MEM0_ENV_FILE choose the key file.
{
  const custom = path.join(tmp, "custom-dir", "keys.env");
  resetEnv({ MEM0_API_URL: "http://127.0.0.1:19999", MEM0_API_KEY: KEY, MEM0_ENV_FILE: custom });
  const ctx = freshCtx("custom-env-file");
  const { h } = stubHelpers();
  await mem0.configureModelRouting(ctx, h);
  check("MEM0_ENV_FILE selects the key file (0600, dir 0700)", fs.readFileSync(custom, "utf8") === `MEM0_API_KEY=${KEY}\n` && modeOf(custom) === 0o600 && modeOf(path.dirname(custom)) === 0o700);
  resetEnv({ MEM0_API_URL: "http://127.0.0.1:19999", MEM0_API_KEY: KEY, MEM0_ENV_FILE: "relative/path.env" });
  check("a relative env file path is refused", /must be absolute/.test(await dies(() => mem0.configureModelRouting(freshCtx("rel-env"), h))));
}

// stackEnv, configToml, summary, resolvePorts.
{
  resetEnv({ MEM0_API_URL: "http://127.0.0.1:19999/", MEM0_API_KEY: KEY });
  const ctx = freshCtx("quiet");
  const { h, out } = stubHelpers();
  await mem0.init(ctx, h);
  const env = mem0.stackEnv(ctx, h);
  check("stackEnv hands the host URL to scripts/setup.mjs and nothing else", Object.keys(env.env).join() === "MEM0_API_URL" && env.env.MEM0_API_URL === "http://127.0.0.1:19999" && !JSON.stringify(env).includes(KEY));
  check("stackEnv description names setup.mjs (not setup.sh)", /scripts\/setup\.mjs/.test(env.description) && !/setup\.sh/.test(env.description));
  const toml = mem0.configToml(ctx, h);
  check("configToml: [memory.mem0].api_url only, no secret", toml.memory.mem0.api_url === "http://127.0.0.1:19999" && Object.keys(toml).join() === "memory" && !JSON.stringify(toml).includes(KEY));
  const sum = mem0.summary(ctx, h);
  const sumText = JSON.stringify(sum);
  check("summary: running lines say external server and show the container URL", sum.running[0].includes("external server (not managed by this stack)") && sum.running[1].includes("mem0 -> http://host.docker.internal:19999"));
  check("summary: config files list the env file and the stack .env", sum.configFiles[0].includes("mem0.env") && sum.configFiles[1].endsWith("(MEM0_API_URL, MEM0_INDEXER_URL; no secrets)"));
  check("summary: notes cover API keys, AUTH_DISABLED, loopback, OPERATOR.md and docs", /dashboard \(port varies/.test(sumText) && sumText.includes("POST /api-keys") && sumText.includes("AUTH_DISABLED") && sumText.includes("host.docker.internal") && sumText.includes("providers/mem0/OPERATOR.md") && sumText.includes("https://docs.mem0.ai/open-source/features/rest-api"));
  check("summary: no hard-coded :3000 dashboard guess", !/:3000/.test(sumText));
  check("summary: log services are the indexer only, no key", sum.logServices.join() === "indexer" && !sumText.includes(KEY));

  delete process.env.MEM0_API_KEY;
  await mem0.resolvePorts(ctx, h);
  check("resolvePorts exports the normalized MEM0_API_URL, no port probing", process.env.MEM0_API_URL === "http://127.0.0.1:19999" && ctx.mem0.url === "http://127.0.0.1:19999");
  resetEnv({ MEM0_API_URL: "http://u:p@x:1" });
  check("resolvePorts dies on an invalid URL", /credentials/.test(await dies(() => mem0.resolvePorts(freshCtx("rp-bad"), h))));
  check("resolvePorts skips validation for --down", (await dies(() => mem0.resolvePorts(freshCtx("rp-down", { action: "down" }), h))) === "");
  const custom = path.join(tmp, "rp-env", "mem0.env");
  resetEnv({ MEM0_API_URL: "http://127.0.0.1:19999", MEM0_ENV_FILE: custom });
  await mem0.resolvePorts(freshCtx("rp-env"), h);
  check("resolvePorts keeps a custom env file visible to compose", process.env.MEM0_ENV_FILE === custom);
  void out;
}

// clackSetup with a fake Clack `ui`: URL then masked key; the key goes only into the hand-off.
{
  resetEnv();
  const logs = [];
  const ui = {
    text: async (o) => {
      logs.push(`text ${o.message}`);
      return "http://mem0.internal:8000/";
    },
    password: async (o) => {
      logs.push(`password ${o.message}`);
      return ` ${KEY} `;
    },
    isCancel: () => false,
    cancel: () => {},
    note: (m, t) => logs.push(`note ${t}: ${m}`),
  };
  const ctx = { repoRoot: path.join(tmp, "clack"), home: path.join(tmp, "clack-home"), wizardConf: path.join(tmp, "clack-home/wizard.conf"), pmMerged: {} };
  const handoff = await mem0.clackSetup(ctx, ui, stubHelpers().h);
  check("clackSetup hands over the URL, the key and the skip flag", handoff.MEM0_API_URL === "http://mem0.internal:8000" && handoff.PM_MEM0_API_KEY === KEY && handoff.WIZARD_SKIP_BACKEND_STEP === "1");
  check("clackSetup asks for the key with the masked password prompt and prints no key", logs.some((l) => l.startsWith("password ")) && !logs.join("\n").includes(KEY));
  check("clackSetup writes nothing", !fs.existsSync(ctx.home));
  const validate = [];
  await mem0.clackSetup(ctx, { ...ui, text: async (o) => (validate.push(o.validate("http://u:p@h:1"), o.validate("")), "") }, stubHelpers().h);
  check("clackSetup validates the URL prompt (credentials refused, empty accepted)", /credentials/.test(validate[0]) && validate[1] === undefined);
}

// ---------------------------------------------------------------------------
// A node:http stand-in for the mem0 REST server.

async function startMem0({ key = KEY, auth = true, searchMode = "match", retainStatus = 200, deleteStatus = 200, echoKeyOnError = false, errorBody = "", seed = [], retainResults = null, idFor = () => randomUUID() } = {}) {
  const store = new Map();
  for (const m of seed) store.set(m.id, m);
  const log = [];
  const violations = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      const u = new URL(req.url, "http://stub");
      const sent = String(req.headers["x-api-key"] || "");
      log.push({ method: req.method, path: u.pathname, search: u.search, key: sent, body });
      const send = (code, obj, html) => {
        res.writeHead(code, { "Content-Type": html ? "text/html" : "application/json" });
        res.end(html ?? JSON.stringify(obj));
      };
      if (req.method === "GET" && u.pathname === "/docs") return send(200, null, "<html>docs</html>");
      if (auth && sent !== key) return send(401, { detail: "Invalid or missing API key" });
      if (req.method === "POST" && u.pathname === "/memories") {
        if (retainStatus !== 200) return send(retainStatus, { detail: errorBody || (echoKeyOnError ? `server error for ${sent}` : "server error") });
        if (body?.infer !== false) violations.push("retain without infer:false");
        if (!body?.user_id) violations.push("retain without user_id");
        if (retainResults !== null) return send(200, { results: retainResults });
        const id = idFor();
        const memory = body?.messages?.[0]?.content ?? "";
        store.set(id, { id, memory, user_id: body?.user_id, agent_id: body?.agent_id, run_id: body?.run_id });
        return send(200, { results: [{ id, memory, event: "ADD" }] });
      }
      if (req.method === "POST" && u.pathname === "/search") {
        const uid = body?.filters?.user_id;
        const hits = searchMode === "empty" ? [] : [...store.values()].filter((m) => m.user_id === uid);
        return send(200, { results: hits.map((m) => ({ id: m.id, memory: m.memory, score: 0.9 })) });
      }
      if (req.method === "GET" && u.pathname === "/memories") {
        const hits = [...store.values()].filter((m) => m.user_id === u.searchParams.get("user_id") && m.run_id === u.searchParams.get("run_id"));
        return send(200, { results: hits });
      }
      const del = u.pathname.match(/^\/memories\/([^/]+)$/);
      if (req.method === "DELETE" && del) {
        if (deleteStatus !== 200) return send(deleteStatus, { detail: "cannot delete" });
        if (!store.delete(decodeURIComponent(del[1]))) return send(404, { detail: "Memory not found" });
        return send(200, { message: "Memory deleted successfully!" });
      }
      return send(404, { detail: "Not Found" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    store,
    log,
    violations,
    close: () => new Promise((r) => server.close(r)),
  };
}

function smokeCtx(name, stub, { keyInFile = KEY, ...extra } = {}) {
  const ctx = freshCtx(name, extra);
  resetEnv({ MEM0_API_URL: stub.url });
  if (keyInFile) {
    const file = envFileOf(ctx);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `MEM0_API_KEY=${keyInFile}\n`, { mode: 0o600 });
  }
  return ctx;
}

// (b) smoke: success path.
{
  const stub = await startMem0();
  const ctx = smokeCtx("smoke-ok", stub);
  const { h, out } = stubHelpers();
  await mem0.smoke(ctx, h);
  const routes = stub.log.map((r) => `${r.method} ${r.path}`);
  check("smoke: docs, retain, search, cleanup lookup, delete by id", routes[0] === "GET /docs" && routes[1] === "POST /memories" && routes[2] === "POST /search" && routes[3] === "GET /memories" && routes[4].startsWith("DELETE /memories/") && routes.length === 5);
  check("smoke: the cleanup lookup is scoped to the wizard's user_id and run_id with top_k 1000", stub.log[3].search === "?user_id=wizard-smoke&run_id=wizard-smoke-doc&top_k=1000");
  check("smoke: X-API-Key sent on authenticated calls, not on /docs", stub.log[0].key === "" && stub.log.slice(1).every((r) => r.key === KEY));
  const retain = stub.log[1].body;
  check("smoke: retain body is verbatim (infer false) with the fixed ids", retain.infer === false && retain.user_id === "wizard-smoke" && retain.run_id === "wizard-smoke-doc" && retain.agent_id === "personal-memory-wizard" && /heron/.test(retain.messages[0].content));
  check("smoke: search body filters on user_id", stub.log[2].body.filters.user_id === "wizard-smoke" && /codename/.test(stub.log[2].body.query));
  check("smoke: the stub is empty afterwards and saw no violations", stub.store.size === 0 && stub.violations.length === 0);
  check("smoke: the key never appears in the output", !text(out).includes(KEY));
  await stub.close();
}

// Key only in the environment: works, but warns that the indexer reads the file.
{
  const stub = await startMem0();
  const ctx = smokeCtx("smoke-envkey", stub, { keyInFile: "" });
  process.env.MEM0_API_KEY = KEY;
  const { h, out } = stubHelpers();
  await mem0.smoke(ctx, h);
  check("smoke: key from the environment works and warns about the file", stub.store.size === 0 && stub.log[1].key === KEY && /environment only/.test(text(out)) && !text(out).includes(KEY));
  await stub.close();
}

// 401 without a key: actionable die, nothing stored.
{
  const stub = await startMem0();
  const ctx = smokeCtx("smoke-401", stub, { keyInFile: "" });
  const { h } = stubHelpers();
  const msg = await dies(() => mem0.smoke(ctx, h));
  check("smoke 401: die hint names MEM0_API_KEY and the env file", /401/.test(msg) && msg.includes("MEM0_API_KEY") && msg.includes(envFileOf(ctx)));
  check("smoke 401: nothing stored, only /docs, the rejected retain and the cleanup lookup were sent", stub.store.size === 0 && stub.log.every((r) => ["/docs", "/memories"].includes(r.path)));
  await stub.close();
}

// Wrong key.
{
  const stub = await startMem0({ key: "the-real-key" });
  const ctx = smokeCtx("smoke-wrongkey", stub, { keyInFile: "not-the-real-key" });
  const msg = await dies(() => mem0.smoke(ctx, stubHelpers().h));
  check("smoke wrong key: 401 hint, neither key echoed", /401/.test(msg) && !msg.includes("not-the-real-key") && !msg.includes("the-real-key"));
  await stub.close();
}

// Search returns nothing: die with the embedder hint, cleanup still ran.
{
  const stub = await startMem0({ searchMode: "empty" });
  const ctx = smokeCtx("smoke-miss", stub);
  const msg = await dies(() => mem0.smoke(ctx, stubHelpers().h));
  check("smoke search miss: die mentions the embedder key, provider config and logs", /did not return the smoke fact/.test(msg) && /embedder key/.test(msg) && /logs/.test(msg));
  check("smoke search miss: cleanup ran, the stub ends empty", stub.store.size === 0 && stub.log.some((r) => r.method === "DELETE"));
  await stub.close();
}

// Retain fails with the key echoed in the error body: die with status and redacted body.
{
  const stub = await startMem0({ retainStatus: 500, echoKeyOnError: true });
  const ctx = smokeCtx("smoke-500", stub);
  const msg = await dies(() => mem0.smoke(ctx, stubHelpers().h));
  check("smoke retain 500: die names the status, the echoed key is redacted", /500/.test(msg) && !msg.includes(KEY) && msg.includes("***"));
  check("smoke retain 500: stub empty", stub.store.size === 0);
  await stub.close();
}

// Empty retain results: fail (same rule as the sink); do not let leftover search hits false-pass.
{
  const stub = await startMem0({ retainResults: [] });
  const ctx = smokeCtx("smoke-empty-retain", stub);
  const msg = await dies(() => mem0.smoke(ctx, stubHelpers().h));
  check("smoke empty retain: dies on zero memory ids", /no memory ids/.test(msg) && /empty results/.test(msg));
  check("smoke empty retain: never reached search", !stub.log.some((r) => r.path === "/search"));
  await stub.close();
}

// AUTH_DISABLED: no key in the env file, stub accepts unauthenticated calls.
{
  const stub = await startMem0({ auth: false });
  const ctx = smokeCtx("smoke-auth-disabled", stub, { keyInFile: "" });
  const { h, out } = stubHelpers();
  await mem0.smoke(ctx, h);
  check("smoke AUTH_DISABLED: succeeds with no key", stub.store.size === 0 && stub.log.some((r) => r.method === "POST" && r.path === "/memories" && r.key === ""));
  check("smoke AUTH_DISABLED: no key in the output", !text(out).includes(KEY));
  await stub.close();
}

// Cleanup failure: the smoke result stands, the failure is a warning, no key in it.
{
  const stub = await startMem0({ deleteStatus: 500 });
  const ctx = smokeCtx("smoke-del500", stub);
  const { h, out } = stubHelpers();
  await mem0.smoke(ctx, h);
  check("smoke delete failure: warning only (the memory is left behind)", /warn could not delete smoke memory/.test(text(out)) && stub.store.size === 1 && !text(out).includes(KEY));
  await stub.close();
}

// Unreachable server: die, no hang.
{
  const dead = await startMem0();
  await dead.close();
  const ctx = smokeCtx("smoke-down", dead);
  const msg = await dies(() => mem0.smoke(ctx, stubHelpers().h));
  check("smoke unreachable server: die with a request-failed message", /mem0 request failed/.test(msg) && !msg.includes(KEY));
}

// Dry run: the four steps are printed and no request is sent.
{
  const stub = await startMem0();
  const ctx = smokeCtx("smoke-dry", stub, { dry: true });
  const { h, out } = stubHelpers();
  await mem0.smoke(ctx, h);
  const planned = out.filter((l) => l.startsWith("[dry-run]   "));
  check("smoke dry run: four planned steps and zero requests", planned.length === 4 && stub.log.length === 0);
  await stub.close();
}

// NIT 4 and 5: cleanup deletes everything under the wizard's ids, whatever happened; server text is sanitised.
{
  const leftover = { id: randomUUID(), memory: "Wizard smoke test: the project codename is heron.", user_id: "wizard-smoke", run_id: "wizard-smoke-doc" };
  const real = { id: randomUUID(), memory: "my real memory", user_id: "someone", run_id: "other" };
  const stub = await startMem0({ seed: [leftover, real] });
  const ctx = smokeCtx("smoke-leftover", stub);
  await mem0.smoke(ctx, stubHelpers().h);
  check("smoke cleanup removes leftovers of an earlier run, and only the wizard's own", !stub.store.has(leftover.id) && stub.store.has(real.id) && stub.store.size === 1);
  await stub.close();

  const failing = await startMem0({ searchMode: "empty", seed: [{ ...leftover, id: randomUUID() }] });
  const failCtx = smokeCtx("smoke-leftover-fail", failing);
  await dies(() => mem0.smoke(failCtx, stubHelpers().h));
  check("smoke cleanup also removes leftovers when the smoke itself fails", failing.store.size === 0);
  await failing.close();

  const noisy = await startMem0({ retainStatus: 500, errorBody: "\u001b[31mred\u0007 line\nbreak\u009b" });
  const msg = await dies(() => mem0.smoke(smokeCtx("smoke-ctrl", noisy), stubHelpers().h));
  check("server error text has its control characters stripped before it is printed", /500/.test(msg) && !/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/.test(msg));
  await noisy.close();

  const odd = await startMem0({ idFor: () => "../../etc/passwd" });
  const oddOut = stubHelpers();
  const oddMsg = await dies(() => mem0.smoke(smokeCtx("smoke-oddid", odd), oddOut.h));
  check("a server id that is not a plain identifier fails smoke (zero safe ids)", /no memory ids/.test(oddMsg));
  check(
    "a server id that is not a plain identifier is never used in a request or printed",
    odd.log.every((r) => r.method !== "DELETE") && !text(oddOut.out).includes("passwd") && !oddMsg.includes("passwd"),
  );
  await odd.close();

  // The key/env file cannot be read: no key leaks, cleanup still runs.
  const stub2 = await startMem0({ seed: [{ ...leftover, id: randomUUID() }], auth: false });
  const dirAsFile = path.join(tmp, "env-is-a-dir");
  fs.mkdirSync(dirAsFile, { recursive: true });
  const ctx2 = smokeCtx("smoke-unreadable", stub2, { keyInFile: "" });
  process.env.MEM0_ENV_FILE = dirAsFile;
  const msg2 = await dies(() => mem0.smoke(ctx2, stubHelpers().h));
  check("an unreadable env file fails with a clear message", /cannot read the mem0 env file/.test(msg2));
  check("an unreadable env file does not skip cleanup", stub2.log.some((r) => r.method === "GET" && r.path === "/memories") && stub2.store.size === 0);
  await stub2.close();
}

// beforeStack: warns (never fails) when the server is absent; no key is ever sent.
{
  const stub = await startMem0();
  const ctx = smokeCtx("before-ok", stub);
  const { h, out } = stubHelpers();
  await mem0.beforeStack(ctx, h);
  check("beforeStack: reachable server is ok and only GET /docs without a key is sent", /ok mem0 server answers/.test(text(out)) && stub.log.length === 1 && stub.log[0].path === "/docs" && stub.log[0].key === "");
  await stub.close();
  const dead = smokeCtx("before-down", stub);
  const down = stubHelpers();
  await mem0.beforeStack(dead, down.h);
  check("beforeStack: an unreachable server is a warning, not a failure", /warn mem0 server is not reachable/.test(text(down.out)));
  const loose = smokeCtx("before-mode", stub);
  fs.chmodSync(envFileOf(loose), 0o644);
  const lh = stubHelpers();
  await mem0.beforeStack(loose, lh.h);
  check("beforeStack: a group/other readable env file is a warning with the fix", /warn .*mem0\.env is group\/other accessible \(mode 644\); run: chmod 600/.test(text(lh.out)));
  const dryCtx = smokeCtx("before-dry", stub, { dry: true });
  const dh = stubHelpers();
  await mem0.beforeStack(dryCtx, dh.h);
  check("beforeStack dry run: prints what would be checked", /\[dry-run\] check .*\/docs answers/.test(text(dh.out)));
}

// (d) extendValidation error cases.
{
  resetEnv({ MEM0_API_URL: "http://127.0.0.1:19999" });
  const files = ["providers/mem0/compose.yaml"];
  const run = async (name, setup) => {
    const ctx = freshCtx(name, { memoryProvider: { ...manifest, compose: { ...manifest.compose, files } } });
    fs.mkdirSync(path.join(ctx.repoRoot, "providers/mem0"), { recursive: true });
    fs.writeFileSync(path.join(ctx.repoRoot, "providers/mem0/compose.yaml"), "services: {}\n");
    setup(ctx);
    const { h } = stubHelpers();
    ctx.validationErrors = [];
    ctx.validationChecks = [];
    await mem0.extendValidation(ctx, h);
    return ctx;
  };
  const goodEnv = (ctx) => fs.writeFileSync(path.join(ctx.repoRoot, ".env"), "HOST_UID=1\nMEM0_API_URL=http://127.0.0.1:19999\nMEM0_INDEXER_URL=http://host.docker.internal:19999\n");

  const good = await run("val-good", (ctx) => {
    goodEnv(ctx);
    fs.mkdirSync(path.dirname(envFileOf(ctx)), { recursive: true });
    fs.writeFileSync(envFileOf(ctx), `MEM0_API_KEY=${KEY}\n`, { mode: 0o600 });
  });
  check("validation: a good setup has no errors and records checks", good.validationErrors.length === 0 && good.validationChecks.length >= 4);

  const noFile = await run("val-nofile", goodEnv);
  check("validation: an absent env file is fine (auth-disabled servers)", noFile.validationErrors.length === 0);

  resetEnv({ MEM0_API_URL: "ftp://x" });
  const badUrl = await run("val-url", goodEnv);
  check("validation: a URL that does not parse is an error", badUrl.validationErrors.some((e) => e.startsWith("mem0 API URL:")));
  resetEnv({ MEM0_API_URL: "http://127.0.0.1:19999" });

  const open = await run("val-mode", (ctx) => {
    goodEnv(ctx);
    fs.mkdirSync(path.dirname(envFileOf(ctx)), { recursive: true });
    fs.writeFileSync(envFileOf(ctx), `MEM0_API_KEY=${KEY}\n`, { mode: 0o640 });
    fs.chmodSync(envFileOf(ctx), 0o640);
  });
  check("validation: an env file with group/other bits is an error", open.validationErrors.some((e) => /must not be group\/other accessible/.test(e)));
  check("validation: the error does not contain the key", !JSON.stringify(open.validationErrors).includes(KEY));

  const leaked = await run("val-leak", (ctx) => {
    fs.writeFileSync(path.join(ctx.repoRoot, ".env"), `HOST_UID=1\nMEM0_API_URL=http://127.0.0.1:19999\nMEM0_INDEXER_URL=http://host.docker.internal:19999\nMEM0_API_KEY=${KEY}\n`);
  });
  check("validation: MEM0_API_KEY in the stack .env is an error", leaked.validationErrors.some((e) => /repo \.env must not hold MEM0_API_KEY/.test(e)));
  check("validation: that error does not contain the key", !JSON.stringify(leaked.validationErrors).includes(KEY));

  const missing = await run("val-missing", (ctx) => fs.writeFileSync(path.join(ctx.repoRoot, ".env"), "HOST_UID=1\n"));
  check("validation: the stack .env must carry both mem0 URLs", missing.validationErrors.includes("repo .env missing MEM0_INDEXER_URL") && missing.validationErrors.includes("repo .env missing MEM0_API_URL"));

  const noCompose = await run("val-compose", (ctx) => {
    goodEnv(ctx);
    fs.rmSync(path.join(ctx.repoRoot, "providers"), { recursive: true });
  });
  check("validation: a missing compose fragment is an error", noCompose.validationErrors.some((e) => /missing compose file/.test(e)));

  const badIndexer = await run("val-indexer", (ctx) => {
    fs.writeFileSync(
      path.join(ctx.repoRoot, ".env"),
      "HOST_UID=1\nMEM0_API_URL=http://127.0.0.1:19999\nMEM0_INDEXER_URL=http://127.0.0.1:19999\n",
    );
  });
  check(
    "validation: MEM0_INDEXER_URL must match the rewrite of MEM0_API_URL",
    badIndexer.validationErrors.some((e) => /MEM0_INDEXER_URL must match/.test(e) && /host\.docker\.internal:19999/.test(e)),
  );

  resetEnv({ MEM0_API_URL: "https://api.mem0.ai" });
  const hosted = await run("val-hosted", (ctx) => {
    fs.writeFileSync(
      path.join(ctx.repoRoot, ".env"),
      "HOST_UID=1\nMEM0_API_URL=https://api.mem0.ai\nMEM0_INDEXER_URL=https://api.mem0.ai\n",
    );
  });
  check("validation: api.mem0.ai is soft-rejected", hosted.validationErrors.some((e) => /api\.mem0\.ai/.test(e) && /self-hosted/.test(e)));
  resetEnv({ MEM0_API_URL: "http://127.0.0.1:19999" });

  resetEnv({ MEM0_API_URL: "http://mem0.example:8000" });
  {
    const ctx = freshCtx("val-http-key-warn", { memoryProvider: { ...manifest, compose: { ...manifest.compose, files } } });
    fs.mkdirSync(path.join(ctx.repoRoot, "providers/mem0"), { recursive: true });
    fs.writeFileSync(path.join(ctx.repoRoot, "providers/mem0/compose.yaml"), "services: {}\n");
    fs.writeFileSync(
      path.join(ctx.repoRoot, ".env"),
      "HOST_UID=1\nMEM0_API_URL=http://mem0.example:8000\nMEM0_INDEXER_URL=http://mem0.example:8000\n",
    );
    fs.mkdirSync(path.dirname(envFileOf(ctx)), { recursive: true });
    fs.writeFileSync(envFileOf(ctx), `MEM0_API_KEY=${KEY}\n`, { mode: 0o600 });
    const { h, out } = stubHelpers();
    ctx.validationErrors = [];
    ctx.validationChecks = [];
    await mem0.extendValidation(ctx, h);
    check(
      "validation: non-loopback http + key warns about cleartext",
      /warn .*cleartext/.test(text(out)) && ctx.validationErrors.length === 0,
    );
    check("validation: that warn does not echo the key", !text(out).includes(KEY));
  }
  resetEnv({ MEM0_API_URL: "http://127.0.0.1:19999" });
}

// setupCodingAgent: non-silent; pluginPackage stays null.
{
  resetEnv({ MEM0_API_URL: "http://127.0.0.1:19999" });
  const ctx = freshCtx("coding-agent");
  const { h, out } = stubHelpers();
  await mem0.setupCodingAgent(ctx, h);
  const t = text(out);
  check("setupCodingAgent is exported", typeof mem0.setupCodingAgent === "function");
  check("setupCodingAgent prints SDK / MCP / REST steps", /SDK/.test(t) && /MCP/.test(t) && /REST/.test(t) && t.includes("/memories") && t.includes("/search"));
  check("setupCodingAgent keeps pluginPackage null", manifest.codingAgent?.pluginPackage === null);
  check("setupCodingAgent points at OPERATOR.md", t.includes("providers/mem0/OPERATOR.md"));
}


// ---------------------------------------------------------------------------
// B1: the key is read the way docker compose's env_file loader reads it.
{
  const forms = [
    ["plain", "MEM0_API_KEY=abc\n", "abc"],
    ["export prefix", "export MEM0_API_KEY=abc\n", "abc"],
    ["spaces around key and value", "  MEM0_API_KEY = abc  \n", "abc"],
    ["double quotes", 'MEM0_API_KEY="abc def"\n', "abc def"],
    ["single quotes then a comment", "MEM0_API_KEY='abc' # rotated\n", "abc"],
    ["quoted hash", 'MEM0_API_KEY="a # b"\n', "a # b"],
    ["inline comment", "MEM0_API_KEY=abc # note\n", "abc"],
    ["hash without a space stays in the value", "MEM0_API_KEY=abc#def\n", "abc#def"],
    ["a leading hash is the value", "MEM0_API_KEY=#abc\n", "#abc"],
    ["CRLF line ends", "FOO=1\r\nMEM0_API_KEY=abc\r\n", "abc"],
    ["export, quotes and CRLF", "export MEM0_API_KEY='abc'\r\n", "abc"],
    ["empty value", "MEM0_API_KEY=\n", ""],
    ["empty double quotes", 'MEM0_API_KEY=""\n', ""],
    ["empty single quotes", "MEM0_API_KEY=''\n", ""],
    ["commented out", "# MEM0_API_KEY=abc\n", ""],
    ["similar key names", "MEM0_API_KEY_OLD=abc\nX_MEM0_API_KEY=y\n", ""],
    ["duplicate: the last wins", "MEM0_API_KEY=old\nMEM0_API_KEY=new\n", "new"],
    ["duplicate: an empty last wins", "MEM0_API_KEY=old\nMEM0_API_KEY=\n", ""],
    ["duplicate across export and CRLF", "MEM0_API_KEY=stale\r\nexport MEM0_API_KEY='fresh' # r\r\n", "fresh"],
    ["unterminated quote", 'MEM0_API_KEY="abc\n', ""],
  ];
  const dir = path.join(tmp, "forms");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content, want] of forms) {
    const file = path.join(dir, "k.env");
    fs.writeFileSync(file, content);
    check(`readKey form: ${name}`, readKey(file) === want && parseEnvValue(content, "MEM0_API_KEY") === want);
  }
  check("readKey: an absent file is no key", readKey(path.join(dir, "absent.env")) === "");

  // Cross-check against the real compose loader when docker compose is installed.
  const { spawnSync } = await import("node:child_process");
  const probe = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
  if (probe.status === 0) {
    fs.writeFileSync(path.join(dir, "compose.yaml"), "services:\n  a:\n    image: x\n    env_file:\n      - path: k.env\n        required: false\n");
    let same = 0;
    const diffs = [];
    for (const [name, content, want] of forms) {
      fs.writeFileSync(path.join(dir, "k.env"), content);
      const r = spawnSync("docker", ["compose", "-f", "compose.yaml", "config", "--format", "json"], { cwd: dir, encoding: "utf8" });
      let got;
      try {
        got = JSON.parse(r.stdout).services.a.environment?.MEM0_API_KEY ?? "";
      } catch {
        got = "(compose refuses the file)";
      }
      const expected = name === "unterminated quote" ? "(compose refuses the file)" : want;
      if (got === expected) same++;
      else diffs.push(name);
    }
    check(`readKey agrees with docker compose on all ${forms.length} forms`, diffs.length === 0);
    if (diffs.length) console.log(`      differs: ${diffs.join(", ")}`);
    void same;
  } else console.log("skip  docker compose not installed: parser cross-check skipped");
}

// setupNotices (the real scripts/setup.mjs function) uses the same parse.
{
  const note = (name, content, { dirMode = 0o700, fileMode = 0o600, stackEnvText = "" } = {}) => {
    const home = path.join(tmp, `notice-${name}`);
    const repo = path.join(home, "stack");
    const dir = path.join(home, ".config/personal-memory");
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(repo, { recursive: true });
    fs.chmodSync(dir, dirMode);
    if (content !== null) fs.writeFileSync(path.join(dir, "mem0.env"), content, { mode: fileMode });
    if (content !== null) fs.chmodSync(path.join(dir, "mem0.env"), fileMode);
    if (stackEnvText) fs.writeFileSync(path.join(repo, ".env"), stackEnvText);
    return mem0.setupNotices({ repo, home, env: {} }).join("\n");
  };
  const needs = (t) => t.includes("needs an API key");
  check("setupNotices: a plain key means no note", !needs(note("plain", "MEM0_API_KEY=abc\n")));
  check("setupNotices: `export MEM0_API_KEY=...` is a key", !needs(note("export", "export MEM0_API_KEY=abc\n")));
  check("setupNotices: a quoted key with a comment and CRLF is a key", !needs(note("quoted", 'MEM0_API_KEY="abc" # c\r\n')));
  check('setupNotices: MEM0_API_KEY="" is no key', needs(note("empty-dq", 'MEM0_API_KEY=""\n')));
  check("setupNotices: MEM0_API_KEY= is no key", needs(note("empty", "MEM0_API_KEY=\n")));
  check("setupNotices: a commented key is no key", needs(note("commented", "# MEM0_API_KEY=abc\n")));
  check("setupNotices: a duplicate with an empty last value is no key", needs(note("dup-empty", "MEM0_API_KEY=abc\nMEM0_API_KEY=\n")));
  check("setupNotices: a duplicate with a key last is a key", !needs(note("dup-key", "MEM0_API_KEY=\nMEM0_API_KEY=abc\n")));
  check("setupNotices: an absent file is no key", needs(note("absent", null)));
  check("setupNotices: a 644 key file is flagged", /readable by group or others \(mode 644\)/.test(note("loose", "MEM0_API_KEY=abc\n", { fileMode: 0o644 })));
  check("setupNotices: a 755 directory is flagged", /accessible to group or others \(mode 755\)/.test(note("loosedir", "MEM0_API_KEY=abc\n", { dirMode: 0o755 })));
  check("setupNotices: no notes at all for a clean setup", note("clean", "MEM0_API_KEY=abc\n") === "");
  const viaStackEnv = path.join(tmp, "notice-custom");
  fs.mkdirSync(path.join(viaStackEnv, "keys"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(viaStackEnv, "stack"), { recursive: true });
  fs.writeFileSync(path.join(viaStackEnv, "keys/m.env"), "MEM0_API_KEY=abc\n", { mode: 0o600 });
  fs.writeFileSync(path.join(viaStackEnv, "stack/.env"), `MEM0_ENV_FILE=${path.join(viaStackEnv, "keys/m.env")}\n`);
  check("setupNotices: follows MEM0_ENV_FILE from the stack .env", mem0.setupNotices({ repo: path.join(viaStackEnv, "stack"), home: viaStackEnv, env: {} }).join("") === "");
}

// prepareStackEnv persists a custom env file path (a path, not a secret).
{
  const home = path.join(tmp, "prep-home");
  const repo = path.join(tmp, "prep-stack");
  fs.mkdirSync(repo, { recursive: true });
  const base = { MEM0_API_URL: "http://127.0.0.1:19999", LITELLM_CONFIG: "/etc/hostname" };
  const plain = mem0.prepareStackEnv({ repo, home, env: base });
  check("prepareStackEnv: no MEM0_ENV_FILE entry or drop without a custom path", !plain.entries.some(([k]) => k === "MEM0_ENV_FILE") && !plain.drop.includes("MEM0_ENV_FILE"));
  const custom = mem0.prepareStackEnv({ repo, home, env: { ...base, MEM0_ENV_FILE: "~/keys/m.env" } });
  check("prepareStackEnv: a custom path is written, ~ expanded, and the old line dropped", custom.entries.some(([k, v]) => k === "MEM0_ENV_FILE" && v === path.join(home, "keys/m.env")) && custom.drop.includes("MEM0_ENV_FILE"));
  for (const bad of ["relative/m.env", "/tmp/a$b.env", "/tmp/a\nINJECT=1", '/tmp/"q".env']) {
    let msg = "";
    try {
      mem0.prepareStackEnv({ repo, home, env: { ...base, MEM0_ENV_FILE: bad } });
    } catch (e) {
      msg = e.message;
    }
    check(`prepareStackEnv: refuses MEM0_ENV_FILE=${JSON.stringify(bad)}`, /MEM0_ENV_FILE/.test(msg));
  }
}

// writeKey: symlinks are followed, the temp file is exclusive and removed.
{
  const home = path.join(tmp, "links");
  const dot = path.join(home, "dotfiles");
  fs.mkdirSync(dot, { recursive: true });
  fs.mkdirSync(path.join(home, ".config/personal-memory"), { recursive: true });
  const target = path.join(dot, "mem0.env");
  fs.writeFileSync(target, "FOO=bar\n", { mode: 0o644 });
  fs.chmodSync(target, 0o644);
  const link = path.join(home, ".config/personal-memory/mem0.env");
  fs.symlinkSync(target, link);
  writeKey(link, KEY);
  check("writeKey through a file symlink: the link survives, the target holds the key at mode 600", fs.lstatSync(link).isSymbolicLink() && fs.readFileSync(target, "utf8") === `FOO=bar\nMEM0_API_KEY=${KEY}\n` && modeOf(target) === 0o600);
  check("writeKey through a file symlink: no temp file left behind", fs.readdirSync(dot).every((n) => !n.includes(".tmp-")));

  const dirTarget = path.join(home, "dotfiles/pm");
  fs.mkdirSync(dirTarget, { recursive: true });
  const dirLink = path.join(home, "cfg-link");
  fs.symlinkSync(dirTarget, dirLink);
  writeKey(path.join(dirLink, "mem0.env"), KEY);
  check("writeKey through a directory symlink: the link survives and the file lands in the target", fs.lstatSync(dirLink).isSymbolicLink() && fs.readFileSync(path.join(dirTarget, "mem0.env"), "utf8") === `MEM0_API_KEY=${KEY}\n`);

  const dangling = path.join(home, ".config/personal-memory/other.env");
  fs.symlinkSync(path.join(dot, "created-later.env"), dangling);
  writeKey(dangling, KEY);
  check("writeKey through a dangling symlink creates the target (mode 600)", fs.lstatSync(dangling).isSymbolicLink() && modeOf(path.join(dot, "created-later.env")) === 0o600);

  const dup = path.join(home, "dups.env");
  fs.writeFileSync(dup, `MEM0_API_KEY=a\r\nexport MEM0_API_KEY="b"\r\nX=1\r\n`);
  writeKey(dup, KEY);
  check("writeKey: every old key line (export, CRLF, duplicates) is replaced by one", fs.readFileSync(dup, "utf8") === `X=1\nMEM0_API_KEY=${KEY}\n`);
}

// NIT 1: the key leaves process.env in the init hook and never lands on ctx.
{
  resetEnv({ PM_MEM0_API_KEY: KEY, MEM0_API_KEY: "other-key" });
  const ctx = freshCtx("capture");
  const { h } = stubHelpers();
  await mem0.init(ctx, h);
  check("init removes PM_MEM0_API_KEY and MEM0_API_KEY from process.env", process.env.PM_MEM0_API_KEY === undefined && process.env.MEM0_API_KEY === undefined);
  check("init keeps the hand-off key privately (hand-off wins over MEM0_API_KEY)", capturedKey() === KEY);
  check("the key is on no context field, serialised or not", !JSON.stringify(ctx).includes(KEY) && !Object.getOwnPropertyNames(ctx.mem0).some((k) => String(ctx.mem0[k]).includes(KEY)));
  await mem0.configureModelRouting(ctx, h);
  check("configure uses the captured key", fs.readFileSync(envFileOf(ctx), "utf8") === `MEM0_API_KEY=${KEY}\n`);
  resetEnv({ MEM0_API_KEY: KEY });
  captureKeyFromEnv();
  check("a plain MEM0_API_KEY is captured and removed too", capturedKey() === KEY && process.env.MEM0_API_KEY === undefined);
}

// NIT 6: warn about a group/other accessible directory.
{
  resetEnv({ MEM0_API_URL: "http://127.0.0.1:19999", MEM0_API_KEY: KEY });
  const ctx = freshCtx("dirmode");
  fs.mkdirSync(path.dirname(envFileOf(ctx)), { recursive: true });
  fs.chmodSync(path.dirname(envFileOf(ctx)), 0o755);
  const { h, out } = stubHelpers();
  await mem0.configureModelRouting(ctx, h);
  check("configure warns when the env file directory is group/other accessible", /warn .*accessible to group or others; run: chmod 700/.test(text(out)));
  const again = stubHelpers();
  await mem0.beforeStack({ ...ctx, dry: true }, again.h);
  check("beforeStack warns about the directory too", /warn .*accessible to group or others; run: chmod 700/.test(text(again.out)));
}

// NIT 8: the summary's API-key note only when there is no key, and not on --down.
{
  resetEnv({ MEM0_API_URL: "http://127.0.0.1:19999" });
  const noKey = freshCtx("sum-nokey");
  const withKey = freshCtx("sum-key");
  fs.mkdirSync(path.dirname(envFileOf(withKey)), { recursive: true });
  fs.writeFileSync(envFileOf(withKey), `export MEM0_API_KEY='${KEY}'\r\n`, { mode: 0o600 });
  const { h } = stubHelpers();
  check("summary: the API key note shows when there is no key", mem0.summary(noKey, h).notes.some((n) => n.startsWith("API key:")));
  check("summary: no API key note once a key exists (export, quotes, CRLF)", !mem0.summary(withKey, h).notes.some((n) => n.startsWith("API key:")) && mem0.summary(withKey, h).notes.length >= 2);
  const emptyKey = freshCtx("sum-empty");
  fs.mkdirSync(path.dirname(envFileOf(emptyKey)), { recursive: true });
  fs.writeFileSync(envFileOf(emptyKey), 'MEM0_API_KEY=""\n', { mode: 0o600 });
  check('summary: MEM0_API_KEY="" still shows the note', mem0.summary(emptyKey, h).notes.some((n) => n.startsWith("API key:")));
  check("summary on --down has no notes", mem0.summary({ ...noKey, action: "down" }, h).notes.length === 0);
}

// NIT 7: the manifest says its HTTP smoke fields are informational.
{
  const m = JSON.parse(fs.readFileSync(path.join(root, "providers/mem0/manifest.json"), "utf8"));
  check("manifest: wizard.note and notes say the HTTP fields are informational", /Informational/.test(m.wizard.note) && /informational/.test(m.notes) && m.wizard.deletePath);
}

// ---------------------------------------------------------------------------
// (c) a real ./setup run (wizard/bin/setup.mjs) against a scratch copy of the tree.

function copyTree(dest) {
  const skip = /(^|\/)(__pycache__|\.pytest_cache|tests|\.git|site|\.codegraph|\.ruff_cache)(\/|$)/;
  for (const entry of ["bin", "cli", "config", "indexer", "providers", "scripts", "sync", "wizard", "compose.yaml", "package.json"]) {
    fs.cpSync(path.join(root, entry), path.join(dest, entry), {
      recursive: true,
      filter: (src) => !skip.test(path.relative(root, src)),
    });
  }
  // copyTree mirrors the shipped tree (mem0 is experimental on main).
}

function writeDockerStub(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "docker");
  fs.writeFileSync(
    file,
    `#!/usr/bin/env bash
echo "docker $*" >> "\${STUB_LOG}"
env >> "\${STUB_LOG}.env"
case "$*" in "compose -p"*) echo "$PWD" >> "\${STUB_LOG}.cwd" ;; esac
case "$1" in
    info|ps) exit 0 ;;
    compose)
        case "$*" in
            *" version"*) echo "Docker Compose version v2.29.0" ;;
            *" run "*) printf 'repo\\t%s/src/demo-repo\\nvault\\t%s/vault\\n' "\${HOME}" "\${HOME}" ;;
        esac ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
}

function makeHome(home) {
  fs.mkdirSync(path.join(home, "src/demo-repo"), { recursive: true });
  fs.mkdirSync(path.join(home, "vault/.obsidian"), { recursive: true });
  fs.writeFileSync(path.join(home, "src/demo-repo/README.md"), "# Demo\n");
}

function listAll(dir) {
  const out = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      out.push(`${path.relative(dir, p)} ${ent.isDirectory() ? "d" : fs.statSync(p).size}`);
      if (ent.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

function runSetup(stack, home, stubBin, log, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(stack, "wizard/bin/setup.mjs"), ...args], {
      cwd: stack,
      env: {
        PATH: `${stubBin}:/usr/bin:/bin`,
        LANG: "C.UTF-8",
        TERM: "dumb",
        HOME: home,
        STUB_LOG: log,
        PM_PROJECT: "pm-mem0-test",
        MEMORY_PROVIDER: "mem0",
        ...env,
      },
    });
    let output = "";
    child.stdout.on("data", (c) => (output += c));
    child.stderr.on("data", (c) => (output += c));
    child.on("close", (code) => resolve({ code, output }));
  });
}

{
  const stubBin = path.join(tmp, "e2e-bin");
  writeDockerStub(stubBin);
  const stack = path.join(tmp, "e2e-stack");
  copyTree(stack);
  const shipped = JSON.parse(fs.readFileSync(path.join(root, "providers/mem0/manifest.json"), "utf8"));
  check("the shipped mem0 manifest is experimental", shipped.status === "experimental");

  const stub = await startMem0();
  const env = { MEM0_API_URL: stub.url, MEM0_API_KEY: KEY };

  // Dry run first: exit 0, nothing written, no traffic.
  const dryHome = path.join(tmp, "e2e-home-dry");
  makeHome(dryHome);
  const stackBefore = listAll(stack);
  const homeBefore = listAll(dryHome);
  const dryLog = path.join(tmp, "e2e-dry.log");
  const dry = await runSetup(stack, dryHome, stubBin, dryLog, ["--yes", "--dry-run"], env);
  check("e2e dry run: exit 0", dry.code === 0);
  if (dry.code !== 0) console.log(dry.output);
  check("e2e dry run: the stack tree and HOME are unchanged", JSON.stringify(listAll(stack)) === JSON.stringify(stackBefore) && JSON.stringify(listAll(dryHome)) === JSON.stringify(homeBefore));
  check("e2e dry run: no traffic to the stub", stub.log.length === 0);
  check("e2e dry run: prints the compose command with the profile and both files", /\[dry-run\] docker compose -p pm-mem0-test -f compose\.yaml -f providers\/mem0\/compose\.yaml --profile mem0 up -d --no-build/.test(dry.output));
  check("e2e dry run: hooks announced and the four smoke steps planned", dry.output.includes("provider mem0: configureModelRouting") && dry.output.includes("provider mem0: smoke") && (dry.output.match(/\[dry-run\]   \d\. /g) || []).length === 4);
  check("e2e dry run: the key is not in the output", !dry.output.includes(KEY));
  const dryDocker = fs.existsSync(dryLog) ? fs.readFileSync(dryLog, "utf8") : "";
  check("e2e dry run: docker saw no up, build or run", !/compose .* (up|build|run) /.test(dryDocker));
  const dryEnvLog = fs.readFileSync(`${dryLog}.env`, "utf8");
  check("e2e dry run: the docker child's environment is recorded, without the key", dryEnvLog.includes("PM_PROJECT=pm-mem0-test") && !dryEnvLog.includes(KEY));

  // Real run.
  const home = path.join(tmp, "e2e-home");
  makeHome(home);
  const log = path.join(tmp, "e2e.log");
  const real = await runSetup(stack, home, stubBin, log, ["--yes"], env);
  if (real.code !== 0 || process.env.MEM0_TEST_VERBOSE) console.log(real.output);
  check("e2e real run: exit 0", real.code === 0);
  const realEnvLog = fs.existsSync(`${log}.env`) ? fs.readFileSync(`${log}.env`, "utf8") : "";
  check("e2e real run (--yes, MEM0_API_KEY): no docker call's environment held the key", realEnvLog.includes("PM_PROJECT=pm-mem0-test") && !realEnvLog.includes(KEY) && !/MEM0_API_KEY/.test(realEnvLog));
  const dockerLog = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
  check("e2e real run: compose up carries both files and --profile mem0", /compose -p pm-mem0-test -f compose\.yaml (-f compose\.override\.yaml )?-f providers\/mem0\/compose\.yaml --profile mem0 up -d/.test(dockerLog));
  const stackEnvText = fs.readFileSync(path.join(stack, ".env"), "utf8");
  check(`e2e real run: stack .env has MEM0_INDEXER_URL=http://host.docker.internal:${stub.port}`, stackEnvText.split("\n").includes(`MEM0_INDEXER_URL=http://host.docker.internal:${stub.port}`));
  check("e2e real run: stack .env keeps the host URL", stackEnvText.split("\n").includes(`MEM0_API_URL=${stub.url}`));
  const keyFile = path.join(home, ".config/personal-memory/mem0.env");
  check("e2e real run: env file exists with the key, mode 600, directory 700", fs.existsSync(keyFile) && fs.readFileSync(keyFile, "utf8") === `MEM0_API_KEY=${KEY}\n` && modeOf(keyFile) === 0o600 && modeOf(path.dirname(keyFile)) === 0o700);
  const secretSinks = [
    ["the stack .env", stackEnvText],
    ["wizard.conf", fs.readFileSync(path.join(home, ".config/hindsight/wizard.conf"), "utf8")],
    ["config.toml", fs.readFileSync(path.join(home, ".config/personal-memory/config.toml"), "utf8")],
    ["index.yml", fs.readFileSync(path.join(home, ".config/hindsight/index.yml"), "utf8")],
    ["compose.override.yaml", fs.readFileSync(path.join(stack, "compose.override.yaml"), "utf8")],
    ["the wizard output (summary included)", real.output],
    ["the docker call log", dockerLog],
  ];
  for (const [what, body] of secretSinks) check(`e2e real run: the API key is not in ${what}`, !body.includes(KEY));
  const conf = fs.readFileSync(path.join(home, ".config/hindsight/wizard.conf"), "utf8");
  check("e2e real run: wizard.conf records the provider and the URL", conf.includes("MEMORY_PROVIDER=mem0") && conf.includes(`MEM0_API_URL=${stub.url}`));
  const toml = fs.readFileSync(path.join(home, ".config/personal-memory/config.toml"), "utf8");
  check("e2e real run: config.toml keeps provider = mem0 and writes [memory.mem0]", /provider = "mem0"/.test(toml) && /\[memory\.mem0\]/.test(toml) && toml.includes(`api_url = "${stub.url}"`));
  const routes = stub.log.map((r) => `${r.method} ${r.path}`);
  check("e2e real run: the stub saw retain, search and delete", routes.includes("POST /memories") && routes.includes("POST /search") && routes.some((r) => r.startsWith("DELETE /memories/")));
  check("e2e real run: authenticated calls carried the key, open /docs calls did not", stub.log.filter((r) => r.path !== "/docs").every((r) => r.key === KEY) && stub.log.filter((r) => r.path === "/docs").every((r) => r.key === ""));
  check("e2e real run: the stub ended empty, no infer violations", stub.store.size === 0 && stub.violations.length === 0);
  check("e2e real run: summary shows the external server and the container URL", real.output.includes("external server (not managed by this stack)") && real.output.includes(`mem0 -> http://host.docker.internal:${stub.port}`));
  check("e2e real run: validation passed", real.output.includes("memory setup validation passed"));
  check("e2e real run: every compose call ran in the stack root", [...new Set(fs.readFileSync(`${log}.cwd`, "utf8").split("\n").filter(Boolean))].join() === stack);

  // A second run is a clean no-op for files: same key, same URL.
  const again = await runSetup(stack, home, stubBin, path.join(tmp, "e2e2.log"), ["--yes"], env);
  check("e2e rerun: exit 0 with zero changes", again.code === 0 && /^wizard: changed=0$/m.test(again.output));
  if (!(again.code === 0 && /^wizard: changed=0$/m.test(again.output))) console.log(again.output.split("\n").slice(-12).join("\n"));
  check("e2e rerun: the stub is still empty", stub.store.size === 0);

  // --yes without a key against an auth-enabled stub: the smoke dies with the actionable hint.
  const bareHome = path.join(tmp, "e2e-home-nokey");
  makeHome(bareHome);
  const bare = await runSetup(stack, bareHome, stubBin, path.join(tmp, "e2e3.log"), ["--yes"], { MEM0_API_URL: stub.url });
  check("e2e without a key: the smoke fails with the MEM0_API_KEY hint (exit 1)", bare.code === 1 && /401/.test(bare.output) && bare.output.includes("MEM0_API_KEY") && !fs.existsSync(path.join(bareHome, ".config/personal-memory/mem0.env")));
  check("e2e without a key: the stub is still empty", stub.store.size === 0);

  // Clack-style hand-off: PM_MEM0_API_KEY (and the skip flag) instead of MEM0_API_KEY.
  const clackHome = path.join(tmp, "e2e-home-clack");
  makeHome(clackHome);
  const clackLog = path.join(tmp, "e2e-clack.log");
  const clack = await runSetup(stack, clackHome, stubBin, clackLog, ["--yes"], { MEM0_API_URL: stub.url, PM_MEM0_API_KEY: KEY, WIZARD_SKIP_BACKEND_STEP: "1" });
  if (clack.code !== 0) console.log(clack.output);
  const clackEnvLog = fs.existsSync(`${clackLog}.env`) ? fs.readFileSync(`${clackLog}.env`, "utf8") : "";
  check("e2e Clack hand-off: exit 0 and the key file written (mode 600)", clack.code === 0 && fs.readFileSync(path.join(clackHome, ".config/personal-memory/mem0.env"), "utf8") === `MEM0_API_KEY=${KEY}\n`);
  check("e2e Clack hand-off: no docker call's environment held the key", clackEnvLog.includes("PM_PROJECT=pm-mem0-test") && !clackEnvLog.includes(KEY) && !/MEM0_API_KEY/.test(clackEnvLog));
  check("e2e Clack hand-off: the key is not in the output", !clack.output.includes(KEY));

  // --up (stack-only path): the URL comes from wizard.conf / the stack .env, the key from the env file.
  const tracesBefore = stub.log.length;
  const upLog = path.join(tmp, "e2e-up.log");
  const up = await runSetup(stack, home, stubBin, upLog, ["--up", "--yes"], {});
  if (up.code !== 0) console.log(up.output);
  const upDocker = fs.existsSync(upLog) ? fs.readFileSync(upLog, "utf8") : "";
  check("e2e --up: exit 0, compose up with the profile and both files", up.code === 0 && /compose -p pm-mem0-test -f compose\.yaml (-f compose\.override\.yaml )?-f providers\/mem0\/compose\.yaml --profile mem0 up -d/.test(upDocker));
  check("e2e --up: no configure steps (no key write, no index step)", !up.output.includes("3. mem0 server URL and API key") && !up.output.includes("Sources to index"));
  const upTraffic = stub.log.slice(tracesBefore);
  check("e2e --up: the smoke ran with the key from the env file", upTraffic.some((r) => r.method === "POST" && r.path === "/memories" && r.key === KEY) && stub.store.size === 0);
  check("e2e --up: validation passed, no API-key note (a key exists), key not printed", up.output.includes("memory setup validation passed") && !up.output.includes("API key:") && !up.output.includes(KEY));

  // Hand-edited env file: export, quotes, comment, CRLF, duplicates (the last wins, as in compose).
  const keyPath = path.join(home, ".config/personal-memory/mem0.env");
  fs.writeFileSync(keyPath, `# edited by hand\r\nMEM0_API_KEY=stale-key\r\nexport MEM0_API_KEY='${KEY}' # rotated\r\nOTHER=1\r\n`, { mode: 0o600 });
  const handFrom = stub.log.length;
  const hand = await runSetup(stack, home, stubBin, path.join(tmp, "e2e-hand.log"), ["--up", "--yes"], {});
  check("e2e hand-edited env file (export, quotes, comment, CRLF, duplicate): --up passes with the last key", hand.code === 0 && !hand.output.includes("needs an API key") && stub.log.slice(handFrom).filter((r) => r.path === "/memories" && r.method === "POST").length === 1 && stub.log.slice(handFrom).filter((r) => r.path === "/memories" && r.method === "POST").every((r) => r.key === KEY));
  fs.writeFileSync(keyPath, `MEM0_API_KEY=${KEY}\nMEM0_API_KEY=""\n`, { mode: 0o600 });
  const emptied = await runSetup(stack, home, stubBin, path.join(tmp, "e2e-empty.log"), ["--up", "--yes"], {});
  check('e2e a later MEM0_API_KEY="" means no key: setup notes it and the smoke fails with the hint', emptied.code === 1 && emptied.output.includes("needs an API key") && /401/.test(emptied.output));
  fs.writeFileSync(keyPath, `MEM0_API_KEY=${KEY}\n`, { mode: 0o600 });

  // --down: no URL validation, no API-key note, no stub traffic.
  const before = stub.log.length;
  const downLog = path.join(tmp, "e2e-down.log");
  const down = await runSetup(stack, home, stubBin, downLog, ["--down", "--yes"], { MEM0_API_URL: "this is not a url" });
  const downDocker = fs.existsSync(downLog) ? fs.readFileSync(downLog, "utf8") : "";
  check("e2e --down: exit 0 even with an unusable MEM0_API_URL, compose down with the profile", down.code === 0 && /compose -p pm-mem0-test -f compose\.yaml (-f compose\.override\.yaml )?-f providers\/mem0\/compose\.yaml --profile mem0 down/.test(downDocker));
  check("e2e --down: no API-key note and no traffic to the server", !down.output.includes("API key:") && stub.log.length === before);

  // A symlinked env file (dotfile manager): the link survives, the target holds the key.
  const linkHome = path.join(tmp, "e2e-home-link");
  makeHome(linkHome);
  fs.mkdirSync(path.join(linkHome, "dotfiles"), { recursive: true });
  fs.mkdirSync(path.join(linkHome, ".config/personal-memory"), { recursive: true, mode: 0o700 });
  const linkTarget = path.join(linkHome, "dotfiles/mem0.env");
  fs.writeFileSync(linkTarget, "KEEP=me\r\nMEM0_API_KEY=old\r\n", { mode: 0o644 });
  fs.chmodSync(linkTarget, 0o644);
  const linkPath = path.join(linkHome, ".config/personal-memory/mem0.env");
  fs.symlinkSync(linkTarget, linkPath);
  const linked = await runSetup(stack, linkHome, stubBin, path.join(tmp, "e2e-link.log"), ["--yes"], env);
  if (linked.code !== 0) console.log(linked.output);
  check("e2e symlinked env file: link kept, target has the new key and the other line, mode 600", linked.code === 0 && fs.lstatSync(linkPath).isSymbolicLink() && fs.readFileSync(linkTarget, "utf8") === `KEEP=me\nMEM0_API_KEY=${KEY}\n` && modeOf(linkTarget) === 0o600);
  check("e2e symlinked env file: the key is not in the output", !linked.output.includes(KEY));
  check("e2e everything cleaned up on the stub", stub.store.size === 0 && stub.violations.length === 0);

  // A custom env file path is persisted in the stack .env (its own stack copy: the .env is shared state).
  const stack2 = path.join(tmp, "e2e-stack2");
  copyTree(stack2);
  const customHome = path.join(tmp, "e2e-home-custom");
  makeHome(customHome);
  const customFile = path.join(customHome, "keys2/m.env");
  const customRun = await runSetup(stack2, customHome, stubBin, path.join(tmp, "e2e-custom.log"), ["--yes"], { ...env, MEM0_ENV_FILE: "~/keys2/m.env" });
  if (customRun.code !== 0) console.log(customRun.output);
  const stack2Env = fs.readFileSync(path.join(stack2, ".env"), "utf8");
  check("e2e custom MEM0_ENV_FILE: exit 0, key in the custom file (mode 600, dir 700), none in the default", customRun.code === 0 && fs.readFileSync(customFile, "utf8") === `MEM0_API_KEY=${KEY}\n` && modeOf(customFile) === 0o600 && modeOf(path.dirname(customFile)) === 0o700 && !fs.existsSync(path.join(customHome, ".config/personal-memory/mem0.env")));
  check("e2e custom MEM0_ENV_FILE: the stack .env stores the expanded path (one line, no key)", stack2Env.split("\n").filter((l) => l.startsWith("MEM0_ENV_FILE=")).join() === `MEM0_ENV_FILE=${customFile}` && !stack2Env.includes(KEY));
  check("e2e custom MEM0_ENV_FILE: config.toml records env_file", fs.readFileSync(path.join(customHome, ".config/personal-memory/config.toml"), "utf8").includes(`env_file = "${customFile}"`));
  const customUp = await runSetup(stack2, customHome, stubBin, path.join(tmp, "e2e-custom-up.log"), ["--up", "--yes"], { MEM0_API_URL: stub.url });
  check("e2e custom MEM0_ENV_FILE: --up without the variable still finds the key (from the stack .env)", customUp.code === 0 && !customUp.output.includes("needs an API key") && stub.store.size === 0);
  await stub.close();
}

for (const k of ENV_KEYS) {
  if (savedEnv[k] === undefined) delete process.env[k];
  else process.env[k] = savedEnv[k];
}
fs.rmSync(tmp, { recursive: true, force: true });

if (fails) {
  console.log(`${fails} mem0 wizard test(s) failed`);
  process.exit(1);
}
console.log("all mem0 wizard tests passed");
