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
    "--yes + key: config.toml section is [memory.mem0] api_url and carries the provider id",
    sections.memory.provider === "mem0" && sections.memory.mem0.api_url === "http://127.0.0.1:19999" && !("api_key" in sections.memory.mem0),
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
  check("manifest login delegate offered as an info line", text(out).includes("mem0 login"));
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

// Interactive answers (not --yes): URL and key come from the prompts.
{
  resetEnv();
  const ctx = freshCtx("interactive", { yes: false });
  const { h, out, saved, asked } = stubHelpers({
    answers: { "REST server URL": "http://mem0.internal:8000/", "API key": KEY },
  });
  await mem0.configureModelRouting(ctx, h);
  check("interactive: both prompts asked", asked.length === 2 && asked[0].includes("URL") && asked[1].includes("API key"));
  check("interactive: URL answer saved (trailing slash dropped)", saved[0]?.extra.MEM0_API_URL === "http://mem0.internal:8000");
  check("interactive: key written 0600 and not printed", fs.readFileSync(envFileOf(ctx), "utf8") === `MEM0_API_KEY=${KEY}\n` && modeOf(envFileOf(ctx)) === 0o600 && !text(out).includes(KEY));
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
  const toml = mem0.configToml(ctx, h);
  check("configToml: memory.provider kept, [memory.mem0].api_url, no secret", toml.memory.provider === "mem0" && toml.memory.mem0.api_url === "http://127.0.0.1:19999" && !JSON.stringify(toml).includes(KEY));
  const sum = mem0.summary(ctx, h);
  const sumText = JSON.stringify(sum);
  check("summary: running lines say external server and show the container URL", sum.running[0].includes("external server (not managed by this stack)") && sum.running[1].includes("mem0 -> http://host.docker.internal:19999"));
  check("summary: config files list the env file and the stack .env", sum.configFiles[0].includes("mem0.env") && sum.configFiles[1].endsWith("(MEM0_API_URL, MEM0_INDEXER_URL; no secrets)"));
  check("summary: notes cover API keys, dashboard, AUTH_DISABLED, loopback and docs", /dashboard \(http:\/\/127\.0\.0\.1:3000\)/.test(sumText) && sumText.includes("POST /api-keys") && sumText.includes("AUTH_DISABLED") && sumText.includes("host.docker.internal") && sumText.includes("https://docs.mem0.ai/open-source/features/rest-api"));
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

async function startMem0({ key = KEY, auth = true, searchMode = "match", retainStatus = 200, deleteStatus = 200, echoKeyOnError = false } = {}) {
  const store = new Map();
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
        if (retainStatus !== 200) return send(retainStatus, { detail: echoKeyOnError ? `server error for ${sent}` : "server error" });
        if (body?.infer !== false) violations.push("retain without infer:false");
        if (!body?.user_id) violations.push("retain without user_id");
        const id = randomUUID();
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
  check("smoke: four-step sequence (docs, retain, search, delete by id)", routes[0] === "GET /docs" && routes[1] === "POST /memories" && routes[2] === "POST /search" && routes[3].startsWith("DELETE /memories/") && routes.length === 4);
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

  // Real run.
  const home = path.join(tmp, "e2e-home");
  makeHome(home);
  const log = path.join(tmp, "e2e.log");
  const real = await runSetup(stack, home, stubBin, log, ["--yes"], env);
  if (real.code !== 0 || process.env.MEM0_TEST_VERBOSE) console.log(real.output);
  check("e2e real run: exit 0", real.code === 0);
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
