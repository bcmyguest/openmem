#!/usr/bin/env node
/**
 * Tests for the npm package: stack-root materializer (pure functions), pack contents, and an
 * install of the packed tarball into a temp dir. No docker, no publish, no live stack:
 * scratch HOME, PM_STACK_ROOT under tmp, stubbed docker/curl, --dry-run, ports >= 18000.
 *
 *   node scripts/tests/test_cli_package.mjs           everything (installs 2 deps from npm)
 *   node scripts/tests/test_cli_package.mjs --unit    materializer unit tests only
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkPack } from "../check-pack.mjs";
import {
  MANIFEST_NAME,
  hashBytes,
  listShippedFiles,
  planEntry,
  readManifest,
  resolveStackRoot,
  syncStack,
} from "../../cli/stack.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const UNIT_ONLY = process.argv.includes("--unit");

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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `pm-w4-${label}-`));
  tmpRoots.push(d);
  return d;
}
process.on("exit", () => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});

/** @param {string} root @param {Record<string, string | { body: string, mode?: number }>} files */
function writeTree(root, files) {
  for (const [rel, v] of Object.entries(files)) {
    const body = typeof v === "string" ? v : v.body;
    const mode = typeof v === "string" ? 0o644 : v.mode ?? 0o644;
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, { mode });
    fs.chmodSync(abs, mode);
  }
}

const read = (/** @type {string} */ p) => fs.readFileSync(p, "utf8");

// ---------------------------------------------------------------------------
// Unit: resolveStackRoot
// ---------------------------------------------------------------------------
{
  const pkgRoot = tmp("pkg-plain");
  const home = "/h/user";
  const r1 = resolveStackRoot({ pkgRoot, env: {}, home });
  check("stack root default is ~/.local/share/personal-memory/stack", r1.root === "/h/user/.local/share/personal-memory/stack" && r1.copy && r1.mode === "stack");
  const r2 = resolveStackRoot({ pkgRoot, env: { XDG_DATA_HOME: "/x/data" }, home });
  check("XDG_DATA_HOME wins over the default", r2.root === "/x/data/personal-memory/stack");
  const r2b = resolveStackRoot({ pkgRoot, env: { XDG_DATA_HOME: "relative/data" }, home });
  check("relative XDG_DATA_HOME is ignored (XDG spec)", r2b.root === "/h/user/.local/share/personal-memory/stack");
  const r3 = resolveStackRoot({ pkgRoot, env: { PM_STACK_ROOT: "/s/root", XDG_DATA_HOME: "/x" }, home });
  check("PM_STACK_ROOT wins over XDG", r3.root === "/s/root" && r3.copy);
  const r3b = resolveStackRoot({ pkgRoot, env: { PM_STACK_ROOT: "~/pm-stack" }, home });
  check("PM_STACK_ROOT expands ~/", r3b.root === "/h/user/pm-stack");
  const r4 = resolveStackRoot({ pkgRoot, env: { PM_USE_CHECKOUT: "1", PM_STACK_ROOT: "/s/root" }, home });
  check("PM_USE_CHECKOUT=1 uses the package root, no copy", r4.root === pkgRoot && !r4.copy && r4.mode === "checkout");
  fs.mkdirSync(path.join(pkgRoot, ".git"));
  const r5 = resolveStackRoot({ pkgRoot, env: {}, home });
  check("a git checkout uses itself, no copy", r5.root === pkgRoot && !r5.copy);
  const r6 = resolveStackRoot({ pkgRoot, env: { PM_STACK_ROOT: "/s/root" }, home });
  check("explicit PM_STACK_ROOT beats checkout autodetect", r6.root === "/s/root" && r6.copy);
  const r7 = resolveStackRoot({ pkgRoot, env: { PM_STACK_ROOT: pkgRoot }, home });
  check("PM_STACK_ROOT equal to the package root means no copy", !r7.copy);
}

// ---------------------------------------------------------------------------
// Unit: planEntry decision table
// ---------------------------------------------------------------------------
{
  const S = "s";
  check("plan: missing, never recorded -> create", planEntry({ shippedHash: S, disk: null }) === "create");
  check("plan: missing, recorded -> restore", planEntry({ shippedHash: S, disk: null, recordedHash: "r" }) === "restore");
  check("plan: identical -> unchanged", planEntry({ shippedHash: S, disk: S, recordedHash: "r" }) === "unchanged");
  check("plan: identical, untracked -> unchanged (adopted)", planEntry({ shippedHash: S, disk: S }) === "unchanged");
  check("plan: unmodified but outdated -> update", planEntry({ shippedHash: S, disk: "r", recordedHash: "r" }) === "update");
  check("plan: modified -> conflict", planEntry({ shippedHash: S, disk: "u", recordedHash: "r" }) === "conflict");
  check("plan: untracked and different -> conflict-untracked", planEntry({ shippedHash: S, disk: "u" }) === "conflict-untracked");
  check("plan: symlink -> conflict-untracked", planEntry({ shippedHash: S, disk: "symlink", recordedHash: "r" }) === "conflict-untracked");
}

// ---------------------------------------------------------------------------
// Unit: listShippedFiles on a fake package
// ---------------------------------------------------------------------------
const FAKE_V1 = {
  "compose.yaml": "services: {}\n",
  "compose.bench.yaml": "services: {}\n",
  "indexer/Dockerfile": "FROM scratch\n",
  "indexer/watch.py": "print('v1')\n",
  "indexer/tests/test_x.py": "x\n",
  "indexer/__pycache__/watch.cpython-312.pyc": "bytecode",
  "bin/hindsight-project-index": { body: "#!/bin/sh\necho v1\n", mode: 0o755 },
  "bin/__pycache__/x.pyc": "bytecode",
  "sync/Dockerfile": "FROM scratch\n",
  "sync/tests/test_s.py": "x\n",
  "config/index.yml": "sources: []\n",
  "config/notebooklm.yml": "a: 1\n",
  "config/personal-memory.toml.example": "[memory]\n",
  "config/litellm.lemond.yaml": "model_list: []\n",
  "config/machine.env": "SECRET=1\n",
  "config/hindsight.env": "SECRET=1\n",
  "providers/hindsight/manifest.json": "{}\n",
  "providers/hindsight/wizard.mjs": "export {};\n",
  "providers/hindsight/compose.yaml": "services: {}\n",
  "scripts/setup.mjs": "// v1\n",
  "scripts/gen-masks.mjs": "// v1\n",
  "scripts/tests/test_a.mjs": "// test\n",
  "wizard/lib/paths.mjs": "export {};\n",
  "wizard/lib/run-wizard.mjs": "export {};\n",
  "wizard/bin/setup.mjs": "// bin\n",
  ".env": "HOST_UID=1\n",
  "compose.override.yaml": "services: {}\n",
};
{
  const p = tmp("fake-list");
  writeTree(p, FAKE_V1);
  const got = listShippedFiles(p);
  const has = (/** @type {string} */ f) => got.includes(f);
  check("shipped: compose files and Dockerfile build contexts", has("compose.yaml") && has("compose.bench.yaml") && has("indexer/Dockerfile") && has("indexer/watch.py") && has("sync/Dockerfile") && has("bin/hindsight-project-index"));
  check("shipped: config templates only", has("config/index.yml") && has("config/personal-memory.toml.example") && has("config/litellm.lemond.yaml") && !has("config/machine.env") && !has("config/hindsight.env"));
  check("shipped: provider compose fragments but not manifests or hooks", has("providers/hindsight/compose.yaml") && !has("providers/hindsight/manifest.json") && !has("providers/hindsight/wizard.mjs"));
  check("shipped: no tests, bytecode, generated files, wizard code", !got.some((f) => /tests\/|__pycache__|\.pyc$/.test(f)) && !has(".env") && !has("compose.override.yaml") && !has("wizard/lib/run-wizard.mjs") && !has("wizard/bin/setup.mjs"));
  check("shipped: no code (scripts/, wizard/) that must run from the package", !got.some((f) => /^(scripts|wizard)\//.test(f)));
}

// ---------------------------------------------------------------------------
// Unit: syncStack lifecycle
// ---------------------------------------------------------------------------
{
  const pk = tmp("fake-pkg");
  const stack = path.join(tmp("fake-stack"), "stack");
  writeTree(pk, FAKE_V1);
  const base = { pkgRoot: pk, stackRoot: stack, name: "personal-memory" };

  const dry = syncStack({ ...base, version: "1.0.0", dryRun: true });
  check("sync dry-run reports creations and writes nothing", dry.created.length > 5 && !fs.existsSync(stack));

  const r1 = syncStack({ ...base, version: "1.0.0" });
  check("sync v1 creates shipped files", r1.created.includes("compose.yaml") && r1.conflicts.length === 0);
  check("sync keeps the executable bit", (fs.statSync(path.join(stack, "bin/hindsight-project-index")).mode & 0o111) !== 0);
  check("sync does not copy secrets or generated files", !fs.existsSync(path.join(stack, "config/machine.env")) && !fs.existsSync(path.join(stack, ".env")) && !fs.existsSync(path.join(stack, "compose.override.yaml")));
  check("sync does not copy tests or bytecode", !fs.existsSync(path.join(stack, "indexer/tests")) && !fs.existsSync(path.join(stack, "indexer/__pycache__")));
  const m1 = readManifest(stack);
  check("manifest records shipped hashes", m1.files["compose.yaml"] === hashBytes("services: {}\n") && m1.version === "1.0.0" && Object.keys(m1.files).length === listShippedFiles(pk).length);
  check("no temp files left behind", fs.readdirSync(stack, { recursive: true }).every((f) => !String(f).includes(".tmp-")));

  const r1b = syncStack({ ...base, version: "1.0.0" });
  check("re-sync is a no-op", r1b.created.length + r1b.updated.length + r1b.conflicts.length === 0 && r1b.unchanged === r1.created.length);

  // Generated files the wizard writes: never touched, never overwritten.
  writeTree(stack, { ".env": "HOST_UID=1000\n", ".build-hash": "abc\n", "compose.override.yaml": "mine: 1\n", "config/machine.env": "KEY=secret\n", "personal-memory.toml": "[memory]\n" });
  // User edits one shipped file; the next package version changes both it and another.
  fs.appendFileSync(path.join(stack, "compose.yaml"), "# user tweak\n");
  writeTree(pk, { "compose.yaml": "services: {v2: true}\n", "indexer/watch.py": "print('v2')\n", "bin/new-tool": "#!/bin/sh\n" });
  fs.rmSync(path.join(pk, "sync/Dockerfile"));
  const r2 = syncStack({ ...base, version: "2.0.0" });
  check("upgrade updates unmodified shipped files", r2.updated.includes("indexer/watch.py") && read(path.join(stack, "indexer/watch.py")) === "print('v2')\n");
  check("upgrade creates new shipped files", r2.created.includes("bin/new-tool"));
  check("upgrade reports a modified shipped file as a conflict", r2.conflicts.length === 1 && r2.conflicts[0].path === "compose.yaml");
  check("upgrade preserves the user's modified file", read(path.join(stack, "compose.yaml")) === "services: {}\n# user tweak\n");
  check("upgrade never touches generated files", read(path.join(stack, ".env")) === "HOST_UID=1000\n" && read(path.join(stack, "compose.override.yaml")) === "mine: 1\n" && read(path.join(stack, "config/machine.env")) === "KEY=secret\n" && read(path.join(stack, ".build-hash")) === "abc\n" && read(path.join(stack, "personal-memory.toml")) === "[memory]\n");
  check("upgrade never deletes a no-longer-shipped file (reported as orphan)", fs.existsSync(path.join(stack, "sync/Dockerfile")) && r2.orphans.includes("sync/Dockerfile"));
  const m2 = readManifest(stack);
  check("manifest keeps the old record for the conflicted file and bumps version", m2.files["compose.yaml"] === hashBytes("services: {}\n") && m2.version === "2.0.0");

  const r3 = syncStack({ ...base, version: "2.0.0" });
  check("conflict is reported again on the next run (still preserved)", r3.conflicts.length === 1 && read(path.join(stack, "compose.yaml")).includes("# user tweak"));

  fs.rmSync(path.join(stack, "config/index.yml"));
  const r4 = syncStack({ ...base, version: "2.0.0" });
  check("a deleted shipped file is restored", r4.restored.includes("config/index.yml") && fs.existsSync(path.join(stack, "config/index.yml")));

  const r5 = syncStack({ ...base, version: "2.0.0", force: true });
  const backups = fs.readdirSync(stack).filter((f) => /^compose\.yaml\.user-\d+\.bak$/.test(f));
  check("force overwrites a conflict and keeps a backup of the user copy", r5.forced.includes("compose.yaml") && read(path.join(stack, "compose.yaml")) === "services: {v2: true}\n" && backups.length === 1 && read(path.join(stack, backups[0])).includes("# user tweak"));
  check("force leaves generated files alone", read(path.join(stack, ".env")) === "HOST_UID=1000\n");

  // Untracked pre-existing file (no manifest entry, differing content) is a conflict.
  const stack2 = path.join(tmp("fake-stack2"), "s");
  writeTree(stack2, { "compose.yaml": "services: {mine: true}\n" });
  const u = syncStack({ pkgRoot: pk, stackRoot: stack2, version: "2.0.0" });
  check("an untracked file with different content is preserved and reported", u.conflicts.some((c) => c.path === "compose.yaml") && read(path.join(stack2, "compose.yaml")) === "services: {mine: true}\n");

  // Symlink destinations are never followed.
  const stack3 = path.join(tmp("fake-stack3"), "s");
  const victim = path.join(tmp("victim"), "victim.txt");
  fs.writeFileSync(victim, "do not touch\n");
  fs.mkdirSync(stack3, { recursive: true });
  fs.symlinkSync(victim, path.join(stack3, "compose.yaml"));
  const s = syncStack({ pkgRoot: pk, stackRoot: stack3, version: "2.0.0" });
  check("a symlinked destination is a conflict and its target is untouched", s.conflicts.some((c) => c.path === "compose.yaml") && read(victim) === "do not touch\n");

  // Corrupt manifest: refuse instead of guessing.
  const stack4 = path.join(tmp("fake-stack4"), "s");
  fs.mkdirSync(stack4, { recursive: true });
  fs.writeFileSync(path.join(stack4, MANIFEST_NAME), "{not json");
  let threw = false;
  try {
    syncStack({ pkgRoot: pk, stackRoot: stack4, version: "2.0.0" });
  } catch {
    threw = true;
  }
  check("a corrupt manifest is an error, not a silent overwrite", threw && !fs.existsSync(path.join(stack4, "compose.yaml")));

  let threwSame = false;
  try {
    syncStack({ pkgRoot: pk, stackRoot: pk, version: "1" });
  } catch {
    threwSame = true;
  }
  check("syncing a package onto itself is refused", threwSame);
}

// ---------------------------------------------------------------------------
// Package metadata
// ---------------------------------------------------------------------------
check("package name is openmem", pkg.name === "openmem");
check(
  "bin includes openmem (+ aliases) and personal-memory compat (+ setup + notebooklm-mcp + cognee-mcp + install-mcp + install-coding-agent + switch-provider), no bare pm",
  pkg.bin["openmem"] === "cli/personal-memory.mjs" &&
    pkg.bin["openmem-setup"] === "wizard/bin/setup.mjs" &&
    pkg.bin["openmem-mcp"] === "cli/personal-memory-mcp.mjs" &&
    pkg.bin["personal-memory"] === "cli/personal-memory.mjs" &&
    pkg.bin["personal-memory-setup"] === "wizard/bin/setup.mjs" &&
    pkg.bin["personal-memory-notebooklm-mcp"] === "cli/notebooklm-mcp.mjs" &&
    pkg.bin["personal-memory-cognee-mcp"] === "cli/cognee-mcp.mjs" &&
    pkg.bin["personal-memory-install-mcp"] === "cli/install-memory-mcp.mjs" &&
    pkg.bin["personal-memory-install-coding-agent"] === "cli/install-coding-agent.mjs" &&
    pkg.bin["personal-memory-switch-provider"] === "cli/switch-memory-provider.mjs" &&
    !Object.keys(pkg.bin).includes("pm"),
);
check("scripts.install-mcp points at install-memory-mcp.mjs", pkg.scripts?.["install-mcp"] === "node cli/install-memory-mcp.mjs");
check(
  "scripts.switch-provider points at switch-memory-provider.mjs",
  pkg.scripts?.["switch-provider"] === "node cli/switch-memory-provider.mjs",
);
check("cli entry is a real file with a node shebang", !fs.lstatSync(path.join(ROOT, "cli/personal-memory.mjs")).isSymbolicLink() && read(path.join(ROOT, "cli/personal-memory.mjs")).startsWith("#!/usr/bin/env node"));
check("engines.node >=20.12.0 (the @clack/prompts floor) and publishConfig.access public", pkg.engines?.node === ">=20.12.0" && pkg.publishConfig?.access === "public");
check("type is module and deps include @clack/prompts + @iarna/toml", pkg.type === "module" && Boolean(pkg.dependencies?.["@clack/prompts"]) && Boolean(pkg.dependencies?.["@iarna/toml"]));
check("repository/homepage/bugs point at bcmyguest/openmem", /bcmyguest\/openmem/.test(JSON.stringify([pkg.repository, pkg.homepage, pkg.bugs])));
{
  const wp = path.join(ROOT, "wizard/package.json");
  if (fs.existsSync(wp)) {
    const w = JSON.parse(read(wp));
    const drift = Object.entries(w.dependencies || {}).filter(([k, v]) => pkg.dependencies?.[k] !== v);
    check("wizard/package.json deps match the root package.json", drift.length === 0, drift.join("; "));
  }
}
check("package.json scripts: test and pack:check", Boolean(pkg.scripts?.test) && Boolean(pkg.scripts?.["pack:check"]));

if (UNIT_ONLY) {
  finish();
}

// ---------------------------------------------------------------------------
// Pack contents (npm pack --dry-run)
// ---------------------------------------------------------------------------
const dry = checkPack({ root: ROOT });
const leaks = dry.problems.filter((p) => p.startsWith("machine path"));
const structural = dry.problems.filter((p) => !p.startsWith("machine path"));
check(`npm pack --dry-run: ${dry.count} files, required present, nothing forbidden`, structural.length === 0, structural.join("\n"));
check("npm pack --dry-run: no machine paths (/home/, /Users/) in packed text files", leaks.length === 0, leaks.join("\n"));

// ---------------------------------------------------------------------------
// Install the packed tarball and drive the CLI
// ---------------------------------------------------------------------------

/** @param {string} cwd @param {string[]} args */
function run(cwd, args, extra = {}) {
  return spawnSync("npm", args, { cwd, encoding: "utf8", ...extra });
}

const work = tmp("install");
const packDir = path.join(work, "pack");
fs.mkdirSync(packDir);
const packed = run(ROOT, ["pack", "--pack-destination", packDir, "--ignore-scripts", "--json"]);
check("npm pack produces a tarball", packed.status === 0, packed.stderr);
const tgzName = packed.status === 0 ? JSON.parse(packed.stdout)[0].filename : "";
const tgz = path.join(packDir, tgzName);

const tarCheck = checkPack({ root: ROOT, tarball: tgz });
check("tarball content gate matches the dry run", JSON.stringify(tarCheck.files) === JSON.stringify([...dry.files].sort()), `dry=${dry.count} tarball=${tarCheck.count}`);

const proj = path.join(work, "proj");
fs.mkdirSync(proj);
fs.writeFileSync(path.join(proj, "package.json"), '{"private":true}\n');
const installArgs = ["install", "--no-audit", "--no-fund", "--ignore-scripts", tgz];
let inst = run(proj, [...installArgs.slice(0, 1), "--offline", ...installArgs.slice(1)]);
if (inst.status !== 0) inst = run(proj, installArgs); // offline cache cold: fall back to online
check("npm install of the tarball succeeds", inst.status === 0, (inst.stderr || inst.stdout).slice(-600));

const bin = path.join(proj, "node_modules/.bin/personal-memory");
const installed = path.join(proj, "node_modules", pkg.name);
check("bin link and installed package exist", fs.existsSync(bin) && fs.existsSync(path.join(installed, "cli/personal-memory.mjs")));

// Scratch environment: stubbed docker/curl, scratch HOME, ports >= 18000, throwaway project name.
const stubs = path.join(work, "stubs");
fs.mkdirSync(stubs);
const stubLog = path.join(work, "stub.log");
writeTree(stubs, {
  docker: {
    mode: 0o755,
    body: `#!/usr/bin/env bash
echo "docker $*" >> "${stubLog}"
case "$1" in
    info|ps) exit 0 ;;
    compose)
        case "$*" in
            *" version"*) echo "Docker Compose version v2.29.0" ;;
            *" run "*) printf 'repo\\t%s/src/demo-repo\\nvault\\t%s/vault\\n' "$HOME" "$HOME" ;;
        esac ;;
esac
exit 0
`,
  },
  curl: {
    mode: 0o755,
    body: `#!/usr/bin/env bash
echo "curl $*" >> "${stubLog}"
case "$*" in
    */v1/models*) echo '{"object":"list","data":[{"id":"Gemma-4-E2B-it-GGUF","downloaded":true}]}' ;;
    */api/tags*) exit 7 ;;
    *) echo '{}' ;;
esac
exit 0
`,
  },
  ollama: { mode: 0o755, body: '#!/usr/bin/env bash\nexit 0\n' },
  lemonade: { mode: 0o755, body: '#!/usr/bin/env bash\nexit 0\n' },
  npx: { mode: 0o755, body: '#!/usr/bin/env bash\nexit 0\n' },
});

/** @param {string} home */
function makeHome(home) {
  fs.mkdirSync(path.join(home, "src/demo-repo"), { recursive: true });
  fs.mkdirSync(path.join(home, "vault/.obsidian"), { recursive: true });
  spawnSync("git", ["init", "-q", path.join(home, "src/demo-repo")]);
  fs.writeFileSync(path.join(home, "src/demo-repo/README.md"), "# Demo\n");
}

const nodeDir = path.dirname(process.execPath);
/** @param {string} home @param {Record<string, string>} [extra] */
function cliEnv(home, extra = {}) {
  return {
    PATH: `${stubs}:${nodeDir}:/usr/bin:/bin`,
    LANG: "C.UTF-8",
    TERM: "dumb",
    HOME: home,
    PM_PROJECT: "pm-test-w4",
    HINDSIGHT_PORT: "18891",
    HINDSIGHT_CP_PORT: "18991",
    ...extra,
  };
}

/** @param {string} cmdBin @param {string[]} args @param {Record<string, string>} env */
function cli(cmdBin, args, env, cwd = work) {
  return spawnSync(cmdBin, args, { cwd, env, encoding: "utf8", input: "" });
}

const home = path.join(work, "home");
makeHome(home);
const stackRoot = path.join(work, "stack-root");
const env = cliEnv(home, { PM_STACK_ROOT: stackRoot });
const homeBefore = fs.readdirSync(home, { recursive: true }).sort().join("\n");

const v = cli(bin, ["--version"], env);
check("--version prints the package.json version", v.status === 0 && v.stdout.trim() === pkg.version, v.stderr + v.stdout);
check("--version does not materialize the stack", !fs.existsSync(stackRoot));

const h = cli(bin, ["--help"], env);
check("--help lists the commands", h.status === 0 && /providers/.test(h.stdout) && /doctor/.test(h.stdout) && /PM_STACK_ROOT/.test(h.stdout), h.stderr);

const pv = cli(bin, ["providers"], env);
check("providers lists hindsight as supported", pv.status === 0 && /hindsight\s+supported/.test(pv.stdout), pv.stdout + pv.stderr);
const pj = cli(bin, ["providers", "--json"], env);
let providers = [];
try {
  providers = JSON.parse(pj.stdout);
} catch {
  // asserted below
}
check("providers --json is valid and includes every packed manifest", providers.some((p) => p.id === "hindsight") && providers.length === dry.files.filter((f) => /^providers\/[^/]+\/manifest\.json$/.test(f)).length);

const bad = cli(bin, ["frobnicate"], env);
check("unknown command exits 2", bad.status === 2 && /unknown command/.test(bad.stderr));

const guard = cli(process.execPath, [path.join(installed, "wizard/bin/setup.mjs"), "--help"], cliEnv(home));
check("wizard entry refuses to run inside the npm package dir without PM_STACK_ROOT", guard.status === 1 && /read-only/.test(guard.stderr), guard.stderr);

const cfg = cli(bin, ["configure", "--dry-run", "--yes"], env);
check("configure --dry-run --yes exits 0", cfg.status === 0, (cfg.stdout + cfg.stderr).slice(-1500));
check(
  "configure --dry-run --yes plans a compose up in project pm-test-w4",
  /docker compose -p pm-test-w4 --profile hindsight up -d/.test(cfg.stdout + cfg.stderr),
  (cfg.stdout + cfg.stderr).slice(-800),
);
check("stack root materialized (compose, build contexts, templates, manifest)", ["compose.yaml", "compose.bench.yaml", "indexer/Dockerfile", "indexer/watch.py", "bin/hindsight-project-index", "sync/Dockerfile", "config/index.yml", "config/personal-memory.toml.example", MANIFEST_NAME].every((f) => fs.existsSync(path.join(stackRoot, f))));
check("stack bin/ keeps the executable bit", (fs.statSync(path.join(stackRoot, "bin/hindsight-project-index")).mode & 0o111) !== 0);
check("stack root has no code that must stay in the package", !fs.existsSync(path.join(stackRoot, "wizard")) && !fs.existsSync(path.join(stackRoot, "scripts")) && !fs.existsSync(path.join(stackRoot, "providers/hindsight/manifest.json")));
check("dry-run wrote no generated files into the stack or the package", ["", "../node_modules/" + pkg.name].every((rel) => { const d = path.join(stackRoot, rel); return [".env", ".build-hash", "compose.override.yaml"].every((f) => !fs.existsSync(path.join(d, f))); }));
const homeAfter = fs.readdirSync(home, { recursive: true }).sort().join("\n");
check("scratch HOME unchanged by dry-run", homeAfter === homeBefore, `${homeBefore}\n--\n${homeAfter}`);

// Install coding-agent wiring from the packed package, then check that every
// registered command points at the stable copy rather than this npm install.
const agentHome = path.join(work, "agent-home");
makeHome(agentHome);
const agentEnv = cliEnv(agentHome, { PM_STACK_ROOT: path.join(work, "agent-stack") });
const agentBin = path.join(proj, "node_modules/.bin/personal-memory-install-coding-agent");
const agentInstall = cli(agentBin, ["--yes"], agentEnv);
const agentRuntime = path.join(agentHome, ".local/share/personal-memory/agent-runtime");
check("packed coding-agent installer succeeds", agentInstall.status === 0, agentInstall.stdout + agentInstall.stderr);
check("packed coding-agent installer stages a stable runtime", fs.existsSync(path.join(agentRuntime, "cli/coding-agent/hook-runner.mjs")) && fs.existsSync(path.join(agentRuntime, "node_modules/yaml/package.json")));
const agentSettings = [
  path.join(agentHome, ".claude/settings.json"),
  path.join(agentHome, ".codex/config.toml"),
  path.join(agentHome, ".cursor/hooks.json"),
  path.join(agentHome, ".config/opencode/opencode.json"),
];
check("packed coding-agent installer wires four agents to the stable runtime", agentSettings.every((p) => fs.existsSync(p) && read(p).includes(agentRuntime) && !read(p).includes(installed)));
const agentReinstall = cli(agentBin, ["--yes"], agentEnv);
check("packed coding-agent reinstall succeeds without duplicate runtime hooks", agentReinstall.status === 0 && agentSettings.every((p) => read(p).split(agentRuntime).length === 2), agentReinstall.stdout + agentReinstall.stderr);

// Generated files, a local edit and a simulated package upgrade.
fs.writeFileSync(path.join(stackRoot, ".env"), "HOST_UID=1000\n");
fs.writeFileSync(path.join(stackRoot, "compose.override.yaml"), "services: {}\n");
fs.writeFileSync(path.join(stackRoot, "config/machine.env"), "KEY=secret\n");
fs.appendFileSync(path.join(stackRoot, "compose.yaml"), "# user edit\n");
const pkgWatch = path.join(installed, "indexer/watch.py");
fs.chmodSync(pkgWatch, 0o644);
fs.appendFileSync(pkgWatch, "# shipped in a later version\n");
fs.appendFileSync(path.join(installed, "compose.yaml"), "# shipped change to a file the user also edited\n");

const re = cli(bin, ["init", "--json"], env);
let rep = null;
try {
  rep = JSON.parse(re.stdout);
} catch {
  // asserted below
}
check("re-init reports the user-modified shipped file as a conflict", re.status === 0 && rep?.report?.conflicts?.some((c) => c.path === "compose.yaml"), re.stdout + re.stderr);
check("re-init preserves the user-modified file", read(path.join(stackRoot, "compose.yaml")).endsWith("# user edit\n") && !read(path.join(stackRoot, "compose.yaml")).includes("shipped change"));
check("re-init updates an unmodified shipped file from the new package", rep?.report?.updated?.includes("indexer/watch.py") && read(path.join(stackRoot, "indexer/watch.py")).endsWith("# shipped in a later version\n"));
check("re-init leaves generated files alone", read(path.join(stackRoot, ".env")) === "HOST_UID=1000\n" && read(path.join(stackRoot, "compose.override.yaml")) === "services: {}\n" && read(path.join(stackRoot, "config/machine.env")) === "KEY=secret\n");
const reText = cli(bin, ["init"], env);
check("init prints CONFLICT for a human", /CONFLICT compose\.yaml/.test(reText.stdout), reText.stdout);
const forced = cli(bin, ["init", "--force", "--json"], env);
check("init --force overwrites the conflict and keeps a backup", JSON.parse(forced.stdout || "{}").report?.forced?.includes("compose.yaml") && fs.readdirSync(stackRoot).some((f) => /^compose\.yaml\.user-\d+\.bak$/.test(f)) && !read(path.join(stackRoot, "compose.yaml")).includes("# user edit"));

// Default location: no PM_STACK_ROOT.
const xdg = path.join(work, "xdg");
const x = cli(bin, ["init", "--json"], cliEnv(home, { XDG_DATA_HOME: xdg }));
check("default stack root honors XDG_DATA_HOME", JSON.parse(x.stdout || "{}").stackRoot === path.join(xdg, "personal-memory/stack") && fs.existsSync(path.join(xdg, "personal-memory/stack/compose.yaml")), x.stdout + x.stderr);
const d = cli(bin, ["init", "--json"], cliEnv(home));
check("default stack root is ~/.local/share/personal-memory/stack", JSON.parse(d.stdout || "{}").stackRoot === path.join(home, ".local/share/personal-memory/stack"), d.stdout + d.stderr);

// PM_USE_CHECKOUT=1 uses the package directory in place and copies nothing.
const co = cli(bin, ["init", "--json"], cliEnv(home, { PM_USE_CHECKOUT: "1", PM_STACK_ROOT: path.join(work, "unused") }));
const coj = JSON.parse(co.stdout || "{}");
check("PM_USE_CHECKOUT=1 uses the package root with no copy", coj.mode === "checkout" && coj.report === null && !fs.existsSync(path.join(work, "unused")) && fs.realpathSync(coj.stackRoot) === fs.realpathSync(installed), co.stdout + co.stderr);

// A git checkout run (this repo): no copy, version and providers work in place.
const cv = cli(process.execPath, [path.join(ROOT, "cli/personal-memory.mjs"), "--version"], cliEnv(home, { PM_USE_CHECKOUT: "1" }));
check("checkout: node cli/personal-memory.mjs --version", cv.status === 0 && cv.stdout.trim() === pkg.version, cv.stderr);
const ci = cli(process.execPath, [path.join(ROOT, "cli/personal-memory.mjs"), "init", "--json"], cliEnv(home, { PM_USE_CHECKOUT: "1" }));
check("checkout: init uses the checkout in place", JSON.parse(ci.stdout || "{}").report === null && fs.realpathSync(JSON.parse(ci.stdout || "{}").stackRoot) === fs.realpathSync(ROOT), ci.stdout + ci.stderr);

// scripts/setup.mjs runs from the package and must write .env into the stack, not the package.
const sandbox = path.join(work, "stack-setup");
const sx = cli(bin, ["init"], cliEnv(home, { PM_STACK_ROOT: sandbox }));
check("fresh stack for the setup.mjs check", sx.status === 0, sx.stderr);
const ss = cli(process.execPath, [path.join(installed, "scripts/setup.mjs")], cliEnv(home, { PM_STACK_ROOT: sandbox, PM_PACKAGE_ROOT: installed }), sandbox);
check("package scripts/setup.mjs writes .env + compose.override.yaml into the stack only", ss.status === 0 && fs.existsSync(path.join(sandbox, ".env")) && fs.existsSync(path.join(sandbox, "compose.override.yaml")) && !fs.existsSync(path.join(installed, ".env")) && !fs.existsSync(path.join(installed, "compose.override.yaml")), ss.stdout + ss.stderr);

finish();

function finish() {
  if (fails) {
    console.log(`${fails} cli/package test(s) failed`);
    process.exit(1);
  }
  console.log("all cli/package tests passed");
  process.exit(0);
}
