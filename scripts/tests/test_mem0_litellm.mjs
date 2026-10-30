#!/usr/bin/env node
/**
 * mem0 "route mem0's LLM through the stack LiteLLM" option: route rendering, the mem0 config
 * snippet, the wizard step (--yes, interactive, --dry-run), the stack .env step, the compose
 * profile on the up command, the summary, and a real `./setup --yes --dry-run` against a scratch
 * stack root with a fake docker. Everything is under a temp dir; no real stack is touched.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";
import { loadManifest } from "../../wizard/lib/providers/registry.mjs";
import { createHelpers } from "../../wizard/lib/provider-wizard/helpers.mjs";
import { composeArgs } from "../../wizard/lib/compose.mjs";

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
const lib = await import(pathToFileURL(path.join(root, "providers/mem0/lib/litellm.mjs")).href);
const stackEnvLib = await import(pathToFileURL(path.join(root, "providers/mem0/lib/stack-env.mjs")).href);
const manifest = loadManifest("mem0");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pm-mem0-litellm-"));
const ANTHROPIC = "sk-ant-test-NOT-A-KEY-0123";

const ENV_KEYS = [
  "MEM0_API_URL",
  "MEM0_API_KEY",
  "PM_MEM0_API_KEY",
  "MEM0_ENV_FILE",
  "MEM0_LITELLM",
  "MEM0_LITELLM_BACKEND",
  "MEM0_LITELLM_MODEL",
  "MEM0_LITELLM_API_BASE",
  "MEM0_LITELLM_EMBED_MODEL",
  "MEM0_LITELLM_PORT",
  "MEM0_LITELLM_CONFIG",
  "LITELLM_ENV_FILE",
  "ANTHROPIC_API_KEY",
  "PM_ANTHROPIC_API_KEY",
  "MERIDIAN_BASE",
  "MERIDIAN_API_KEY",
];
function resetEnv(extra = {}) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, extra);
}

function stubHelpers({ answers = {}, portFree = true, chosenPort = null } = {}) {
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
    confirm: async (_ctx, prompt, defYN) => {
      asked.push(prompt);
      const hit = Object.keys(answers).find((k) => prompt.includes(k));
      if (hit) return ["y", "yes"].includes(String(answers[hit]).toLowerCase());
      return defYN === "y";
    },
    portFree: async () => portFree,
    choosePort: async (_ctx, _label, port) => chosenPort ?? port,
    saveWizardConf: (_ctx, extra, opts) => saved.push({ extra, opts }),
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
const text = (out) => out.join("\n");
const modeOf = (p) => fs.statSync(p).mode & 0o777;
const routesOf = (ctx) => path.join(ctx.home, ".config/personal-memory/mem0-litellm.yaml");

// ---------------------------------------------------------------------------
// Route files: valid YAML, the memory-llm alias, keys only as os.environ references, master key enforced.
{
  const parse = (c) => YAML.parse(lib.renderRoutes(c));
  const ollama = parse({ backend: "ollama", model: "gemma4:e2b", apiBase: "http://host.docker.internal:11434", embedModel: "nomic-embed-text" });
  check("ollama routes: memory-llm -> ollama_chat/<model> and memory-embed -> ollama/<embed>", ollama.model_list[0].model_name === "memory-llm" && ollama.model_list[0].litellm_params.model === "ollama_chat/gemma4:e2b" && ollama.model_list[1].model_name === "memory-embed" && ollama.model_list[1].litellm_params.model === "ollama/nomic-embed-text");
  check("every route file requires the master key", ollama.general_settings.master_key === "os.environ/LITELLM_MASTER_KEY");
  const noEmbed = parse({ backend: "ollama", model: "m", apiBase: "http://h:1", embedModel: "" });
  check("ollama without an embedding model has only memory-llm", noEmbed.model_list.length === 1);
  const custom = parse({ backend: "custom", model: "Qwen3", apiBase: "http://host.docker.internal:8080/v1", embedModel: "text-embedding-3-small" });
  check("custom routes: openai/<model> at the base URL with Hindsight's custom key variable", custom.model_list[0].litellm_params.model === "openai/Qwen3" && custom.model_list[0].litellm_params.api_base === "http://host.docker.internal:8080/v1" && custom.model_list[0].litellm_params.api_key === "os.environ/LEMOND_API_KEY" && custom.model_list[1].litellm_params.model === "openai/text-embedding-3-small");
  const anthropic = parse({ backend: "anthropic", model: "claude-haiku-5-5", apiBase: "", embedModel: "" });
  check("anthropic routes: anthropic/<model>, key from ANTHROPIC_API_KEY, no api_base, no embedding", anthropic.model_list.length === 1 && anthropic.model_list[0].litellm_params.model === "anthropic/claude-haiku-5-5" && anthropic.model_list[0].litellm_params.api_key === "os.environ/ANTHROPIC_API_KEY" && !("api_base" in anthropic.model_list[0].litellm_params));
  const meridian = parse({ backend: "meridian", model: "claude-haiku-5-5", apiBase: "http://host.docker.internal:3456", embedModel: "" });
  check("meridian routes: anthropic/<model> at Meridian with MERIDIAN_API_KEY, reasoning_effort dropped", meridian.model_list[0].litellm_params.api_base === "http://host.docker.internal:3456" && meridian.model_list[0].litellm_params.api_key === "os.environ/MERIDIAN_API_KEY" && meridian.model_list[0].litellm_params.additional_drop_params[0] === "reasoning_effort");
  check("no route file contains a literal secret", ![ollama, custom, anthropic, meridian].some((r) => JSON.stringify(r).match(/api_key":"(?!os\.environ\/)/)));
}

// Choice validation.
{
  const base = { backend: "ollama", model: "m", apiBase: "http://h:1", embedModel: "", port: "4000" };
  check("a valid choice has no problem", lib.choiceProblem(base) === "");
  check("unknown backend refused", /MEM0_LITELLM_BACKEND/.test(lib.choiceProblem({ ...base, backend: "lemond" })));
  check("a model id with YAML syntax refused", /characters/.test(lib.choiceProblem({ ...base, model: "a: b" })));
  check("an embedding model on a Claude backend refused", /no embedding model/.test(lib.choiceProblem({ ...base, backend: "anthropic", embedModel: "x" })));
  check("a bad port refused", /port/i.test(lib.choiceProblem({ ...base, port: "70000" })) && /port/i.test(lib.choiceProblem({ ...base, port: "4k" })));
  check("an API base with credentials refused", /credentials/.test(lib.choiceProblem({ ...base, apiBase: "http://u:p@h:1" })));
}

// mem0 config snippet: provider openai + openai_base_url on loopback (the REST server bundles no litellm provider).
{
  const cfg = lib.mem0Config({ port: "4123", embedModel: "nomic-embed-text" });
  check("snippet: llm provider openai, model memory-llm, openai_base_url on 127.0.0.1:<port>/v1", cfg.llm.provider === "openai" && cfg.llm.config.model === "memory-llm" && cfg.llm.config.openai_base_url === "http://127.0.0.1:4123/v1");
  check("snippet: embedder through LiteLLM with the vector size of nomic-embed-text", cfg.embedder.config.model === "memory-embed" && cfg.embedder.config.openai_base_url === "http://127.0.0.1:4123/v1" && cfg.vector_store.config.embedding_model_dims === 768);
  check("snippet: the key is a placeholder", /LITELLM_MASTER_KEY/.test(cfg.llm.config.api_key) && /^</.test(cfg.llm.config.api_key));
  const claude = lib.mem0Config({ port: 4000, embedModel: "" });
  check("snippet without an embedding model leaves mem0's embedder and vector store alone", !("embedder" in claude) && !("vector_store" in claude));
}

// --yes with MEM0_LITELLM=1 (ollama defaults): routes written, keys saved, profile on, snippet printed.
{
  resetEnv({ MEM0_API_URL: "http://127.0.0.1:19999", MEM0_LITELLM: "1" });
  const ctx = freshCtx("yes-ollama");
  const { h, out, saved } = stubHelpers();
  await mem0.init(ctx, h);
  await mem0.configureModelRouting(ctx, h);
  const routes = YAML.parse(fs.readFileSync(routesOf(ctx), "utf8"));
  check("--yes: route file written (mode 644) with Ollama defaults and nomic-embed-text", routes.model_list[0].litellm_params.model === "ollama_chat/gemma4:e2b" && routes.model_list[1].litellm_params.model === "ollama/nomic-embed-text" && modeOf(routesOf(ctx)) === 0o644);
  const last = saved.at(-1)?.extra || {};
  check("--yes: wizard.conf keeps the URL and records the option", saved.length === 2 && last.MEM0_API_URL === "http://127.0.0.1:19999" && last.MEM0_LITELLM === "1" && last.MEM0_LITELLM_BACKEND === "ollama" && last.MEM0_LITELLM_PORT === "4000");
  check("--yes: compose profile litellm on the up command", ctx.extraComposeProfiles.includes("litellm") && composeArgs(ctx, "up", "-d").join(" ").includes("--profile mem0 --profile litellm"));
  check("--yes: the snippet is printed with the loopback base URL", text(out).includes('"openai_base_url": "http://127.0.0.1:4000/v1"') && text(out).includes("POST this JSON to /configure"));
  const env = mem0.stackEnv(ctx, h).env;
  check("stackEnv hands the option to scripts/setup.mjs", env.MEM0_LITELLM === "1" && env.MEM0_LITELLM_PORT === "4000" && env.MEM0_LITELLM_CONFIG === routesOf(ctx));
  const sum = mem0.summary(ctx, h);
  check("summary: LiteLLM loopback line, route and key files, litellm logs", sum.running.some((l) => l.includes("http://127.0.0.1:4000/v1") && l.includes("loopback only")) && sum.configFiles.some((l) => l.includes("mem0-litellm.yaml")) && sum.logServices.includes("litellm"));
}

// A busy port: the wizard's port helper picks another; the route file and the stack .env get it.
{
  resetEnv({ MEM0_API_URL: "http://127.0.0.1:19999", MEM0_LITELLM: "1" });
  const ctx = freshCtx("busy-port");
  const { h, saved } = stubHelpers({ chosenPort: 4001 });
  await mem0.configureModelRouting(ctx, h);
  check("port from choosePort is saved and exported", saved.at(-1).extra.MEM0_LITELLM_PORT === "4001" && process.env.MEM0_LITELLM_PORT === "4001");
}

// Anthropic API key: the key goes only to litellm.env (mode 600); no embedding route even if one is asked for.
{
  const litellmEnv = path.join(tmp, "anthropic", ".config/hindsight/litellm.env");
  resetEnv({ MEM0_API_URL: "http://127.0.0.1:19999", MEM0_LITELLM: "1", MEM0_LITELLM_BACKEND: "anthropic", MEM0_LITELLM_EMBED_MODEL: "nomic-embed-text", PM_ANTHROPIC_API_KEY: ANTHROPIC, LITELLM_ENV_FILE: litellmEnv });
  const ctx = freshCtx("anthropic");
  const { h, out, saved } = stubHelpers();
  await mem0.init(ctx, h);
  check("init takes PM_ANTHROPIC_API_KEY out of the environment", !("PM_ANTHROPIC_API_KEY" in process.env));
  await mem0.configureModelRouting(ctx, h);
  const envText = fs.readFileSync(litellmEnv, "utf8");
  check("anthropic: ANTHROPIC_API_KEY written to litellm.env (mode 600) next to a new sk- master key", envText.includes(`ANTHROPIC_API_KEY=${ANTHROPIC}`) && /^LITELLM_MASTER_KEY=sk-/m.test(envText) && modeOf(litellmEnv) === 0o600);
  check("anthropic: no embedding route and the embedder note", !fs.readFileSync(routesOf(ctx), "utf8").includes("memory-embed") && text(out).includes("keeps its own embedder") && saved.at(-1).extra.MEM0_LITELLM_EMBED_MODEL === "");
  check("anthropic: the key is never printed or saved", !text(out).includes(ANTHROPIC) && !JSON.stringify(saved).includes(ANTHROPIC));
}

// Dry run: nothing written, the plan is printed, the port is only probed.
{
  resetEnv({ MEM0_API_URL: "http://127.0.0.1:19999", MEM0_LITELLM: "1", MEM0_LITELLM_BACKEND: "meridian", MERIDIAN_API_KEY: "meridian-secret" });
  const ctx = freshCtx("dry", { dry: true });
  const { h, out, saved } = stubHelpers({ portFree: false });
  await mem0.configureModelRouting(ctx, h);
  check("dry run: no route file, no litellm.env, no wizard.conf save", !fs.existsSync(routesOf(ctx)) && !fs.existsSync(path.join(ctx.hsDir, "litellm.env")) && saved.length === 0);
  check("dry run: plans the route file, the key, the port and the wizard.conf keys", text(out).includes(`[dry-run] write ${routesOf(ctx)}: memory-llm`) && text(out).includes("[dry-run] set MERIDIAN_API_KEY") && text(out).includes("[dry-run] publish LiteLLM on 127.0.0.1:4000 (busy now") && text(out).includes("[dry-run] record MEM0_LITELLM"));
  check("dry run: Meridian prints the Consumer Terms warning and probes nothing", text(out).includes("Consumer Terms") && text(out).includes("[dry-run] probe Meridian"));
  check("dry run: the profile is still planned for the up command", ctx.extraComposeProfiles.includes("litellm"));
  check("dry run: no secret printed", !text(out).includes("meridian-secret"));
}

// Interactive: yes, then backend 2 (custom), base URL, model, embedding model.
{
  resetEnv({ MEM0_API_URL: "http://127.0.0.1:19999" });
  const ctx = freshCtx("interactive", { yes: false });
  const { h, asked, saved } = stubHelpers({
    answers: {
      "REST server URL": "http://127.0.0.1:19999",
      "stack LiteLLM": "y",
      "backend for mem0": "2",
      "base URL": "http://host.docker.internal:13305/v1",
      "Model id": "Qwen3-4B",
      "Embedding model": "none",
    },
  });
  await mem0.configureModelRouting(ctx, h);
  const routes = YAML.parse(fs.readFileSync(routesOf(ctx), "utf8"));
  check("interactive: asks yes/no, backend, URL, model and embedding model", asked.length === 6);
  check("interactive: custom route at the typed URL, no embedding route", routes.model_list.length === 1 && routes.model_list[0].litellm_params.model === "openai/Qwen3-4B" && routes.model_list[0].litellm_params.api_base === "http://host.docker.internal:13305/v1");
  check("interactive: answers saved", saved.at(-1).extra.MEM0_LITELLM_BACKEND === "custom" && saved.at(-1).extra.MEM0_LITELLM_MODEL === "Qwen3-4B");

  // Declining later removes the profile and saves only the URL.
  const again = stubHelpers({ answers: { "REST server URL": "http://127.0.0.1:19999", "stack LiteLLM": "n" } });
  fs.writeFileSync(ctx.wizardConf, "MEMORY_PROVIDER=mem0\nMEM0_LITELLM=1\n");
  ctx.extraComposeProfiles = ["litellm"];
  await mem0.configureModelRouting(ctx, again.h);
  check("declined: profile removed, one save without the option keys", !ctx.extraComposeProfiles.includes("litellm") && again.saved.length === 1 && !("MEM0_LITELLM" in again.saved[0].extra));
  check("declined: stackEnv adds nothing", !("MEM0_LITELLM" in mem0.stackEnv(ctx, again.h).env));
}

// Bad input under --yes stops the run (a problem, not a silent default).
{
  resetEnv({ MEM0_API_URL: "http://127.0.0.1:19999", MEM0_LITELLM: "1", MEM0_LITELLM_PORT: "99999" });
  const ctx = freshCtx("bad-port");
  const { h } = stubHelpers();
  let err = "";
  try {
    await mem0.configureModelRouting(ctx, h);
  } catch (e) {
    err = String(e.message);
  }
  check("an invalid MEM0_LITELLM_PORT stops a real run", /MEM0_LITELLM_PORT/.test(err));
}

// hydrate (--up) adds the profile from wizard.conf.
{
  resetEnv();
  const ctx = freshCtx("hydrate");
  fs.writeFileSync(ctx.wizardConf, "MEMORY_PROVIDER=mem0\nMEM0_API_URL=http://127.0.0.1:19999\nMEM0_LITELLM=1\nMEM0_LITELLM_BACKEND=ollama\nMEM0_LITELLM_MODEL=m\nMEM0_LITELLM_PORT=4002\n");
  const { h } = stubHelpers();
  await mem0.hydrate(ctx, h);
  check("hydrate: the saved option turns the litellm profile on", ctx.extraComposeProfiles.includes("litellm"));
  check("summary from wizard.conf: port 4002", mem0.summary(ctx, h).running.some((l) => l.includes("127.0.0.1:4002")));
  fs.writeFileSync(ctx.wizardConf, "MEMORY_PROVIDER=mem0\nMEM0_API_URL=http://127.0.0.1:19999\n");
  await mem0.hydrate(ctx, h);
  check("hydrate: without the option the profile is off", !ctx.extraComposeProfiles.includes("litellm"));
}

// prepareStackEnv (scripts/setup.mjs): the litellm branch.
{
  const home = path.join(tmp, "stackenv-home");
  const repo = path.join(tmp, "stackenv-repo");
  fs.mkdirSync(repo, { recursive: true });
  const routes = path.join(home, ".config/personal-memory/mem0-litellm.yaml");
  const env = { MEM0_API_URL: "http://127.0.0.1:19999", MEM0_LITELLM: "1", MEM0_LITELLM_PORT: "4005" };
  let err = "";
  try {
    stackEnvLib.prepareStackEnv({ repo, home, env });
  } catch (e) {
    err = String(e.message);
  }
  check("prepareStackEnv: a missing route file is an error", /mem0-litellm\.yaml is missing/.test(err));
  fs.mkdirSync(path.dirname(routes), { recursive: true });
  fs.writeFileSync(routes, "model_list: []\n");
  const spec = stackEnvLib.prepareStackEnv({ repo, home, env });
  const values = Object.fromEntries(spec.entries);
  const litellmEnv = path.join(home, ".config/hindsight/litellm.env");
  check("prepareStackEnv: profiles mem0,litellm, the route file and the port", values.COMPOSE_PROFILES === "mem0,litellm" && values.LITELLM_CONFIG === routes && values.MEM0_LITELLM_PORT === "4005" && spec.drop.includes("MEM0_LITELLM_PORT"));
  check("prepareStackEnv: creates litellm.env with an sk- master key (mode 600)", /^LITELLM_MASTER_KEY=sk-[0-9a-f]{48}$/m.test(fs.readFileSync(litellmEnv, "utf8")) && modeOf(litellmEnv) === 0o600);
  check("prepareStackEnv: no secret in the entries", !JSON.stringify(spec).includes("LITELLM_MASTER_KEY=") && !/sk-[0-9a-f]{10}/.test(JSON.stringify(spec)));
  fs.writeFileSync(litellmEnv, "LITELLM_MASTER_KEY=\n");
  err = "";
  try {
    stackEnvLib.prepareStackEnv({ repo, home, env });
  } catch (e) {
    err = String(e.message);
  }
  check("prepareStackEnv: an empty master key is an error", /LITELLM_MASTER_KEY=sk-\.\.\. is missing/.test(err));
  err = "";
  try {
    stackEnvLib.prepareStackEnv({ repo, home, env: { ...env, MEM0_LITELLM_PORT: "0.0.0.0:4000" } });
  } catch (e) {
    err = String(e.message);
  }
  check("prepareStackEnv: a port with a host part is refused (no 0.0.0.0 bind)", /MEM0_LITELLM_PORT must be a port number/.test(err));
  const off = stackEnvLib.prepareStackEnv({ repo, home, env: { MEM0_API_URL: "http://127.0.0.1:19999" } });
  check("prepareStackEnv: option off keeps COMPOSE_PROFILES=mem0 and adds no port", Object.fromEntries(off.entries).COMPOSE_PROFILES === "mem0" && !off.entries.some(([k]) => k === "MEM0_LITELLM_PORT"));
}

// ---------------------------------------------------------------------------
// ./setup --yes --dry-run (wizard/bin/setup.mjs) from this checkout against a scratch stack root.
function writeDockerStub(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "docker");
  fs.writeFileSync(
    file,
    `#!/usr/bin/env bash
echo "docker $*" >> "\${STUB_LOG}"
case "$1" in
    info|ps) exit 0 ;;
    compose)
        case "$*" in
            *" version"*) echo "Docker Compose version v2.29.0" ;;
            *" run "*) printf 'repo\\t%s/src/demo-repo\\n' "\${HOME}" ;;
        esac ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
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
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}
{
  const stubBin = path.join(tmp, "e2e-bin");
  writeDockerStub(stubBin);
  const home = path.join(tmp, "e2e-home");
  fs.mkdirSync(path.join(home, "src/demo-repo"), { recursive: true });
  // The stack root holds the compose files and build contexts (the wizard hashes indexer/Dockerfile's sources).
  const stack = path.join(tmp, "e2e-stack");
  for (const entry of ["compose.yaml", "providers/mem0/compose.yaml", "bin", "config", "indexer", "sync"]) {
    fs.cpSync(path.join(root, entry), path.join(stack, entry), { recursive: true, filter: (src) => !/(__pycache__|\.pytest_cache|\/tests)(\/|$)/.test(src) });
  }
  const log = path.join(tmp, "e2e.log");
  const homeBefore = listAll(home);
  const stackBefore = listAll(stack);
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, "wizard/bin/setup.mjs"), "--yes", "--dry-run"], {
      cwd: stack,
      env: {
        PATH: `${stubBin}:/usr/bin:/bin`,
        LANG: "C.UTF-8",
        TERM: "dumb",
        HOME: home,
        STUB_LOG: log,
        PM_PROJECT: "pm-mem0-litellm-test",
        PM_STACK_ROOT: stack,
        MEMORY_PROVIDER: "mem0",
        MEM0_API_URL: "http://127.0.0.1:1",
        MEM0_LITELLM: "1",
        MEM0_LITELLM_BACKEND: "anthropic",
        PM_ANTHROPIC_API_KEY: ANTHROPIC,
      },
    });
    let output = "";
    child.stdout.on("data", (c) => (output += c));
    child.stderr.on("data", (c) => (output += c));
    child.on("close", (code) => resolve({ code, output }));
  });
  check("e2e dry run: exit 0", result.code === 0);
  if (result.code !== 0) console.log(result.output);
  check("e2e dry run: HOME and the stack root are unchanged", JSON.stringify(listAll(home)) === JSON.stringify(homeBefore) && JSON.stringify(listAll(stack)) === JSON.stringify(stackBefore));
  check("e2e dry run: the up command carries --profile mem0 --profile litellm", /\[dry-run\] docker compose -p pm-mem0-litellm-test -f compose\.yaml -f providers\/mem0\/compose\.yaml --profile mem0 --profile litellm up -d/.test(result.output));
  check("e2e dry run: route file and key planned, snippet printed", result.output.includes("[dry-run] write ") && result.output.includes("mem0-litellm.yaml: memory-llm") && result.output.includes("[dry-run] set ANTHROPIC_API_KEY") && result.output.includes('"openai_base_url": "http://127.0.0.1:'));
  check("e2e dry run: the Anthropic key is not in the output", !result.output.includes(ANTHROPIC));
  const docker = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
  check("e2e dry run: docker saw no up, build or run", !/compose .* (up|build|run) /.test(docker));
}

resetEnv();
fs.rmSync(tmp, { recursive: true, force: true });
if (fails) {
  console.log(`${fails} mem0 LiteLLM test(s) failed`);
  process.exit(1);
}
console.log("all mem0 LiteLLM tests passed");
