import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ok, die } from "./log.mjs";
import { act } from "./exec.mjs";
import { composeArgs, composeSpawnOptions } from "./compose.mjs";

function buildDockerfile(svc) {
  if (svc === "indexer") return "indexer/Dockerfile";
  die(`the wizard does not build service ${svc}`);
}

function copySourcesFromDockerfile(repoRoot, dfRel) {
  const dfPath = path.join(repoRoot, dfRel);
  const text = fs.readFileSync(dfPath, "utf8");
  const srcs = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("COPY")) continue;
    const parts = line.trim().split(/\s+/).slice(1);
    const filtered = parts.filter((p) => !p.startsWith("--"));
    for (let i = 0; i < filtered.length - 1; i++) srcs.push(filtered[i]);
  }
  return srcs;
}

function expandInputs(repoRoot, rel) {
  const abs = path.join(repoRoot, rel);
  const out = [];
  if (!fs.existsSync(abs)) {
    out.push(rel);
    return out;
  }
  if (fs.statSync(abs).isDirectory()) {
    const walk = (dir, prefix) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.name === "__pycache__" || ent.name.endsWith(".pyc")) continue;
        const p = path.join(dir, ent.name);
        const relP = prefix ? `${prefix}/${ent.name}` : ent.name;
        if (ent.isDirectory()) walk(p, relP);
        else out.push(relP);
      }
    };
    walk(abs, rel);
  } else out.push(rel);
  return out;
}

/**
 * @param {import("./run-wizard.mjs").WizardContext} ctx
 * @param {string} svc
 */
export function buildHash(ctx, svc) {
  const df = buildDockerfile(svc);
  const files = new Set([df, "compose.yaml"]);
  for (const f of ctx.memoryProvider?.compose?.files || []) files.add(f);
  for (const src of copySourcesFromDockerfile(ctx.repoRoot, df)) {
    for (const f of expandInputs(ctx.repoRoot, src)) files.add(f);
  }
  const sorted = [...files].sort();
  const hash = crypto.createHash("sha256");
  for (const f of sorted) {
    const p = path.join(ctx.repoRoot, f);
    if (!fs.existsSync(p)) die(`missing build input ${f}`);
    hash.update(fs.readFileSync(p));
  }
  return hash.digest("hex");
}

/**
 * @param {import("./run-wizard.mjs").WizardContext} ctx
 * @param {string} svc
 * @param {string} hash
 */
function recordBuildHash(ctx, svc, hash) {
  let lines = [];
  if (fs.existsSync(ctx.buildHashFile)) {
    lines = fs
      .readFileSync(ctx.buildHashFile, "utf8")
      .split("\n")
      .filter((l) => l && !l.startsWith(`${svc} `));
  }
  lines.push(`${svc} ${hash}`);
  fs.writeFileSync(ctx.buildHashFile, `${lines.join("\n")}\n`);
}

/**
 * @param {import("./run-wizard.mjs").WizardContext} ctx
 * @param {string} svc
 * @param {string} image
 */
export async function buildService(ctx, svc, image) {
  const hash = buildHash(ctx, svc);
  let stored = "";
  if (fs.existsSync(ctx.buildHashFile)) {
    for (const line of fs.readFileSync(ctx.buildHashFile, "utf8").split("\n")) {
      if (line.startsWith(`${svc} `)) stored = line.split(/\s+/)[1] || "";
    }
  }
  const inspect = spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" });
  const imageOk = inspect.status === 0;
  if (!ctx.rebuild && stored === hash && imageOk) {
    ok(`${svc} image unchanged; build skipped`);
    return;
  }
  await act(
    ctx,
    `build the ${svc} image (compose project ${ctx.project})`,
    "docker",
    composeArgs(ctx, "build", svc),
    composeSpawnOptions(ctx),
  );
  if (ctx.dry) return;
  recordBuildHash(ctx, svc, hash);
}

/**
 * @param {import("./run-wizard.mjs").WizardContext} ctx
 * @returns {Promise<string[]>}
 */
export async function snapshot(ctx) {
  const lines = [];
  const globHs = fs.existsSync(ctx.hsDir) ? fs.readdirSync(ctx.hsDir) : [];
  for (const name of globHs) {
    const f = path.join(ctx.hsDir, name);
    if (fs.statSync(f).isFile()) {
      const h = crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
      lines.push(`${f} ${h}`);
    }
  }
  for (const f of [path.join(ctx.repoRoot, ".env"), path.join(ctx.repoRoot, "compose.override.yaml")]) {
    if (fs.existsSync(f)) {
      const h = crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
      lines.push(`${f} ${h}`);
    }
  }
  const ps = spawnSync("docker", composeArgs(ctx, "ps", "-q"), {
    encoding: "utf8",
    ...composeSpawnOptions(ctx),
  });
  if (ps.status === 0 && ps.stdout) {
    for (const id of ps.stdout.split("\n").filter(Boolean)) {
      lines.push(`container ${id.trim()}`);
    }
  }
  return lines.sort();
}
