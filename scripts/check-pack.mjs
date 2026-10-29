#!/usr/bin/env node
/**
 * Pack-content gate: what `npm publish` would ship must contain the runtime files and
 * nothing machine-specific. Used by CI (`npm run pack:check`) and by test_cli_package.mjs.
 *
 *   node scripts/check-pack.mjs                 inspect `npm pack --dry-run`
 *   node scripts/check-pack.mjs --tarball X.tgz inspect a packed tarball (extracted to a tmp dir)
 *   node scripts/check-pack.mjs --json          machine-readable result
 *
 * Exit 1 when any problem is found. Leak findings are reported, never silently allowed;
 * the only allowlist is ALLOWED_PATH_MENTIONS below.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listShippedFiles } from "../cli/stack.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Files the installed package cannot run without. */
export const REQUIRED = [
  "package.json",
  "README.md",
  "cli/openmem.mjs",
  "cli/notebooklm-mcp.mjs",
  "cli/cognee-mcp.mjs",
  "cli/mem0-mcp.mjs",
  "cli/install-memory-mcp.mjs",
  "cli/switch-memory-provider.mjs",
  "cli/stack.mjs",
  "cli/roots.mjs",
  ".agents/skills/openmem/SKILL.md",
  "wizard/bin/setup.mjs",
  "wizard/bin/pm.mjs",
  "wizard/lib/run-wizard.mjs",
  "wizard/lib/parse-args.mjs",
  "providers/hindsight/manifest.json",
  "providers/hindsight/wizard.mjs",
  "compose.yaml",
  "compose.bench.yaml",
  "indexer/Dockerfile",
  "indexer/watch.py",
  "bin/hindsight-project-index",
  "sync/Dockerfile",
  "config/index.yml",
  "config/notebooklm.yml",
  "config/hindsight.env.example",
  "config/litellm.lemond.yaml",
  "config/openmem.toml.example",
  "scripts/setup.mjs",
  "scripts/gen-masks.mjs",
];

/** Paths that must never be packed. Tested against the posix path inside the package. */
export const FORBIDDEN = [
  [/(^|\/)\.env$/, ".env"],
  [/(^|\/)\.env\.(?!example$)/, ".env.*"],
  [/(^|\/)machine\.env$/, "machine.env"],
  [/(^|\/)hindsight\.env$/, "hindsight.env"],
  [/(^|\/)litellm\.env$/, "litellm.env"],
  [/(^|\/)compose\.override\.ya?ml$/, "compose.override.yaml"],
  [/(^|\/)\.build-hash$/, ".build-hash"],
  [/(^|\/)\.pm-stack-manifest\.json$/, "stack manifest"],
  [/\.pyc$/, "*.pyc"],
  [/(^|\/)__pycache__(\/|$)/, "__pycache__"],
  [/(^|\/)node_modules(\/|$)/, "node_modules"],
  [/(^|\/)\.codegraph(\/|$)/, ".codegraph"],
  [/(^|\/)\.git(\/|$)/, ".git"],
  [/(^|\/)\.agents\/(?!skills\/openmem\/)/, ".agents except openmem skill"],
  [/^site(\/|$)/, "site/"],
  [/ROADMAP/, "ROADMAP*"],
  [/WAVE2/, "WAVE2*"],
  [/\.(tgz|tar|log)$/, "archives/logs"],
];

/**
 * Operator path markers. Container-internal home of the Hindsight image is not a leak.
 */
const LEAK_RE = /\/(?:home|Users)\/[A-Za-z0-9._-]*/g;
export const ALLOWED_PATH_MENTIONS = [/^\/home\/hindsight$/];

/**
 * @param {string} cwd
 * @param {string[]} args
 */
function npm(cwd, args) {
  const r = spawnSync("npm", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`npm ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

/**
 * @param {string} root
 * @returns {{ files: string[], dir: string, cleanup: () => void }}
 */
function listFromDryRun(root) {
  const out = npm(root, ["pack", "--dry-run", "--json", "--ignore-scripts"]);
  const j = JSON.parse(out);
  return { files: j[0].files.map((/** @type {{path: string}} */ f) => f.path), dir: root, cleanup() {} };
}

/**
 * @param {string} tgz
 * @returns {{ files: string[], dir: string, cleanup: () => void }}
 */
function listFromTarball(tgz) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pm-pack-"));
  const r = spawnSync("tar", ["-xzf", path.resolve(tgz), "-C", tmp], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`tar failed: ${r.stderr}`);
  const dir = path.join(tmp, "package");
  /** @type {string[]} */
  const files = [];
  const walk = (/** @type {string} */ rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(child);
      else files.push(child);
    }
  };
  walk("");
  return { files: files.sort(), dir, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

/** @param {Buffer} buf */
function isText(buf) {
  return !buf.subarray(0, 8000).includes(0);
}

/**
 * @typedef {{ ok: boolean, count: number, topLevel: Record<string, number>, problems: string[], files: string[] }} PackResult
 */

/**
 * Check a list of packed files against the gate.
 *
 * @param {{ files: string[], dir: string, license?: string, root?: string }} input
 * @returns {PackResult}
 */
export function evaluatePack({ files, dir, license, root = ROOT }) {
  /** @type {string[]} */
  const problems = [];
  const set = new Set(files);

  for (const req of REQUIRED) {
    if (!set.has(req)) problems.push(`missing required file: ${req}`);
  }
  if (license && license !== "UNLICENSED" && !set.has("LICENSE")) {
    problems.push(`package.json license is ${license} but LICENSE is not packed`);
  }
  // Everything the stack materializer copies must be in the package.
  for (const rel of listShippedFiles(root)) {
    if (!set.has(rel)) problems.push(`stack asset is not packed (update package.json "files"): ${rel}`);
  }
  for (const f of files) {
    for (const [re, label] of FORBIDDEN) {
      if (re.test(f)) problems.push(`forbidden file packed (${label}): ${f}`);
    }
  }
  for (const f of files) {
    const abs = path.join(dir, f);
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      problems.push(`cannot read packed file: ${f}`);
      continue;
    }
    if (!isText(buf)) continue;
    const lines = buf.toString("utf8").split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(LEAK_RE)) {
        if (ALLOWED_PATH_MENTIONS.some((re) => re.test(m[0]))) continue;
        problems.push(`machine path "${m[0]}" in ${f}:${i + 1}`);
      }
    });
  }

  /** @type {Record<string, number>} */
  const topLevel = {};
  for (const f of files) {
    const top = f.includes("/") ? `${f.split("/")[0]}/` : f;
    topLevel[top] = (topLevel[top] || 0) + 1;
  }
  return { ok: problems.length === 0, count: files.length, topLevel, problems, files };
}

/**
 * @param {{ root?: string, tarball?: string }} [opts]
 * @returns {PackResult}
 */
export function checkPack({ root = ROOT, tarball } = {}) {
  const listing = tarball ? listFromTarball(tarball) : listFromDryRun(root);
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    return evaluatePack({ files: listing.files, dir: listing.dir, license: pkg.license, root });
  } finally {
    listing.cleanup();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const ti = argv.indexOf("--tarball");
  const tarball = ti >= 0 ? argv[ti + 1] : undefined;
  const result = checkPack({ tarball });
  if (argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const dirs = Object.entries(result.topLevel)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
    console.log(`pack: ${result.count} files (${dirs})`);
    for (const p of result.problems) console.log(`FAIL  ${p}`);
    if (result.ok) console.log("pack check passed");
  }
  process.exit(result.ok ? 0 : 1);
}
