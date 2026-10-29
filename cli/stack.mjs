/**
 * Stack root: the stable, writable directory the wizard and docker compose run from.
 *
 * Under npx the package directory is a read-only, garbage-collected cache, but the wizard
 * writes .env, .build-hash and compose.override.yaml and uses compose files and the docker
 * build context relative to its repo root. The mutable assets (compose files, indexer/,
 * bin/, sync/, config templates, ...) are therefore copied from the package into the stack
 * root. A manifest of the shipped-file hashes is kept in the stack root so an upgrade
 * overwrites only shipped files the user did not modify, and never touches anything else.
 *
 * Everything here uses node builtins only.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MANIFEST_NAME = ".pm-stack-manifest.json";
export const MANIFEST_SCHEMA = 1;

/** Path segments that are never shipped into the stack. */
const SKIP_SEGMENTS = new Set([
  "__pycache__",
  "tests",
  "node_modules",
  ".pytest_cache",
  ".codegraph",
  ".git",
]);

/**
 * Which package files are materialized into the stack root. Paths are posix-style and
 * relative to the package root. Keep package.json "files" a superset of this list
 * (test_cli_package.mjs and scripts/check-pack.mjs enforce it).
 *
 * @typedef {{ files: string[] } | { tree: string, include?: RegExp }} AssetRule
 * @type {AssetRule[]}
 */
export const STACK_ASSETS = [
  { files: ["compose.yaml", "compose.bench.yaml"] },
  // Docker build contexts: the Dockerfiles COPY from indexer/, bin/, sync/ and config/.
  { tree: "indexer" },
  { tree: "bin" },
  { tree: "sync" },
  {
    tree: "config",
    include:
      /^config\/(?:[^/]+\.example|index\.yml|notebooklm\.yml|litellm\.[^/]+\.yaml|coding-agent\.json)$/,
  },
  // context-proxy mounts ./proxy (LiteLLM config and hook).
  { tree: "proxy" },
  // Per-provider compose fragments (hooks and manifests stay in the read-only package).
  { tree: "providers", include: /^providers\/[^/]+\/compose[^/]*\.ya?ml$/ },
  // Deliberately absent: scripts/ and wizard/. They are code, so they run from the
  // read-only package (PM_PACKAGE_ROOT) and write into the stack (PM_STACK_ROOT).
];

/**
 * @param {string} p
 * @returns {string}
 */
function toPosix(p) {
  return p.split(path.sep).join("/");
}

/**
 * @param {string} root
 * @param {string} rel posix relative dir
 * @param {string[]} out
 */
function walk(root, rel, out) {
  const abs = path.join(root, rel);
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (SKIP_SEGMENTS.has(e.name)) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(root, childRel, out);
    else if (e.isFile() && !e.name.endsWith(".pyc")) out.push(childRel);
  }
}

/**
 * Sorted posix paths (relative to pkgRoot) of every file the stack should contain.
 * Symlinks are never shipped (npm drops them too).
 *
 * @param {string} pkgRoot
 * @param {AssetRule[]} [rules]
 * @returns {string[]}
 */
export function listShippedFiles(pkgRoot, rules = STACK_ASSETS) {
  const out = new Set();
  for (const rule of rules) {
    if ("files" in rule) {
      for (const rel of rule.files) {
        try {
          if (fs.lstatSync(path.join(pkgRoot, rel)).isFile()) out.add(rel);
        } catch {
          // Optional asset absent from this checkout.
        }
      }
    } else {
      const found = [];
      walk(pkgRoot, rule.tree, found);
      for (const rel of found) {
        if (!rule.include || rule.include.test(rel)) out.add(rel);
      }
    }
  }
  return [...out].sort();
}

/**
 * @param {Buffer|string} data
 * @returns {string}
 */
export function hashBytes(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Is the package directory a git checkout (or forced to behave like one)?
 *
 * @param {string} pkgRoot
 * @param {Record<string, string|undefined>} [env]
 */
export function isCheckout(pkgRoot, env = process.env) {
  return env.PM_USE_CHECKOUT === "1" || fs.existsSync(path.join(pkgRoot, ".git"));
}

/**
 * Pick the stack root.
 *
 * Order: PM_USE_CHECKOUT=1 (the package root itself), PM_STACK_ROOT, a git checkout (the
 * package root itself), then ${XDG_DATA_HOME:-~/.local/share}/personal-memory/stack.
 * `copy` is false when the stack root is the package root: nothing is materialized.
 *
 * @param {{ pkgRoot: string, env?: Record<string, string|undefined>, home?: string }} opts
 * @returns {{ root: string, mode: "checkout"|"stack", source: string, copy: boolean }}
 */
export function resolveStackRoot({ pkgRoot, env = process.env, home }) {
  const homeDir = home || env.HOME || os.homedir();
  const pkg = path.resolve(pkgRoot);
  if (env.PM_USE_CHECKOUT === "1") {
    return { root: pkg, mode: "checkout", source: "PM_USE_CHECKOUT", copy: false };
  }
  if (env.PM_STACK_ROOT) {
    let p = env.PM_STACK_ROOT;
    if (p === "~") p = homeDir;
    else if (p.startsWith("~/")) p = path.join(homeDir, p.slice(2));
    const root = path.resolve(p);
    const same = root === pkg;
    return {
      root,
      mode: same ? "checkout" : "stack",
      source: "PM_STACK_ROOT",
      copy: !same,
    };
  }
  if (fs.existsSync(path.join(pkg, ".git"))) {
    return { root: pkg, mode: "checkout", source: "git checkout", copy: false };
  }
  const xdg = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME);
  const dataHome = xdg ? /** @type {string} */ (env.XDG_DATA_HOME) : path.join(homeDir, ".local/share");
  return {
    root: path.join(dataHome, "personal-memory", "stack"),
    mode: "stack",
    source: xdg ? "XDG_DATA_HOME" : "default",
    copy: true,
  };
}

/**
 * @typedef {"create"|"restore"|"unchanged"|"update"|"conflict"|"conflict-untracked"} SyncAction
 */

/**
 * Pure decision for one shipped file.
 *
 * @param {{
 *   shippedHash: string,
 *   disk: null | "symlink" | "not-file" | string,  // null = missing, else sha256
 *   recordedHash?: string,                         // hash written by a previous sync
 * }} s
 * @returns {SyncAction}
 */
export function planEntry({ shippedHash, disk, recordedHash }) {
  if (disk === null) return recordedHash ? "restore" : "create";
  if (disk === "symlink" || disk === "not-file") return "conflict-untracked";
  if (disk === shippedHash) return "unchanged";
  if (recordedHash === undefined) return "conflict-untracked";
  if (disk === recordedHash) return "update";
  return "conflict";
}

/**
 * @param {string} dest
 * @param {Buffer} data
 * @param {number} mode
 */
export function writeAtomic(dest, data, mode) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.writeFileSync(tmp, data, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, dest);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Nothing to clean up.
    }
    throw e;
  }
}

/**
 * @param {string} stackRoot
 * @returns {{ schema: number, name?: string, version?: string, files: Record<string, string> }}
 */
export function readManifest(stackRoot) {
  const file = path.join(stackRoot, MANIFEST_NAME);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { schema: MANIFEST_SCHEMA, files: {} };
  }
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    throw new Error(
      `${file} is not valid JSON; fix or delete it (shipped files will then be treated as untracked)`,
    );
  }
  if (!m || typeof m !== "object" || typeof m.files !== "object" || m.files === null) {
    throw new Error(`${file} has an unexpected shape; fix or delete it`);
  }
  if (typeof m.schema === "number" && m.schema > MANIFEST_SCHEMA) {
    throw new Error(
      `${file} was written by a newer openmem (schema ${m.schema}); upgrade the CLI`,
    );
  }
  return m;
}

/**
 * @param {string} abs
 * @returns {null | "symlink" | "not-file" | { hash: string, data: Buffer }}
 */
function inspectDisk(abs) {
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return null;
    throw e;
  }
  if (st.isSymbolicLink()) return "symlink";
  if (!st.isFile()) return "not-file";
  const data = fs.readFileSync(abs);
  return { hash: hashBytes(data), data };
}

/**
 * @typedef {object} SyncReport
 * @property {string} stackRoot
 * @property {string} version
 * @property {string[]} created
 * @property {string[]} restored
 * @property {string[]} updated
 * @property {number} unchanged
 * @property {{ path: string, reason: string }[]} conflicts  kept as-is; shipped version differs
 * @property {string[]} forced  overwritten under force (user copy saved next to it)
 * @property {string[]} orphans  recorded earlier, no longer shipped; left in place
 * @property {boolean} dryRun
 */

/**
 * Copy the shipped files from pkgRoot into stackRoot without clobbering user changes.
 * Never deletes anything and never touches files that are not in the shipped set.
 *
 * @param {{
 *   pkgRoot: string,
 *   stackRoot: string,
 *   name?: string,
 *   version?: string,
 *   force?: boolean,
 *   dryRun?: boolean,
 *   rules?: AssetRule[],
 * }} opts
 * @returns {SyncReport}
 */
export function syncStack({
  pkgRoot,
  stackRoot,
  name = "openmem",
  version = "0.0.0",
  force = false,
  dryRun = false,
  rules = STACK_ASSETS,
}) {
  const pkg = path.resolve(pkgRoot);
  const stack = path.resolve(stackRoot);
  if (pkg === stack) throw new Error("stack root equals the package root; nothing to materialize");

  if (!dryRun) fs.mkdirSync(stack, { recursive: true });
  const manifest = readManifest(stack);
  const recorded = manifest.files;

  /** @type {SyncReport} */
  const report = {
    stackRoot: stack,
    version,
    created: [],
    restored: [],
    updated: [],
    unchanged: 0,
    conflicts: [],
    forced: [],
    orphans: [],
    dryRun,
  };

  const shipped = listShippedFiles(pkg, rules);
  /** @type {Record<string, string>} */
  const nextFiles = {};
  let manifestDirty = manifest.version !== version || manifest.name !== name;

  for (const rel of shipped) {
    const src = path.join(pkg, rel);
    const data = fs.readFileSync(src);
    const shippedHash = hashBytes(data);
    const mode = fs.statSync(src).mode & 0o111 ? 0o755 : 0o644;
    const dest = path.join(stack, ...rel.split("/"));
    const diskInfo = inspectDisk(dest);
    const disk = diskInfo === null || typeof diskInfo === "string" ? diskInfo : diskInfo.hash;
    const action = planEntry({ shippedHash, disk, recordedHash: recorded[rel] });

    switch (action) {
      case "create":
      case "restore":
      case "update":
        if (!dryRun) writeAtomic(dest, data, mode);
        (action === "create" ? report.created : action === "restore" ? report.restored : report.updated).push(rel);
        nextFiles[rel] = shippedHash;
        break;
      case "unchanged":
        report.unchanged++;
        // Adopt a byte-identical pre-existing file so later upgrades can update it.
        nextFiles[rel] = shippedHash;
        break;
      case "conflict":
      case "conflict-untracked": {
        const reason =
          disk === "symlink"
            ? "destination is a symlink"
            : disk === "not-file"
              ? "destination is not a regular file"
              : action === "conflict"
                ? "modified locally; the new shipped version was not applied"
                : "exists but is not tracked as shipped; left untouched";
        if (force && typeof diskInfo === "object" && diskInfo !== null) {
          if (!dryRun) {
            const backup = `${dest}.user-${Date.now()}.bak`;
            writeAtomic(backup, diskInfo.data, 0o600);
            writeAtomic(dest, data, mode);
          }
          report.forced.push(rel);
          nextFiles[rel] = shippedHash;
        } else {
          report.conflicts.push({ path: rel, reason });
          // Keep the old record so the file stays "modified" next time instead of "untracked".
          if (recorded[rel] !== undefined) nextFiles[rel] = recorded[rel];
        }
        break;
      }
      default:
        throw new Error(`unreachable sync action: ${action}`);
    }
    if (nextFiles[rel] !== recorded[rel]) manifestDirty = true;
  }

  for (const rel of Object.keys(recorded)) {
    if (!shipped.includes(rel)) {
      report.orphans.push(rel);
      manifestDirty = true;
    }
  }

  if (!dryRun && manifestDirty) {
    const body = `${JSON.stringify(
      { schema: MANIFEST_SCHEMA, name, version, files: nextFiles },
      null,
      2,
    )}\n`;
    writeAtomic(path.join(stack, MANIFEST_NAME), Buffer.from(body), 0o644);
  }
  return report;
}

/**
 * Number of files a sync changed on disk.
 *
 * @param {SyncReport} r
 */
export function changedCount(r) {
  return r.created.length + r.restored.length + r.updated.length + r.forced.length;
}

/**
 * Human-readable summary lines.
 *
 * @param {SyncReport} r
 * @returns {string[]}
 */
export function formatReport(r) {
  const lines = [];
  const verb = r.dryRun ? "would be" : "were";
  lines.push(`stack root: ${r.stackRoot} (openmem ${r.version})`);
  if (r.created.length) lines.push(`  ${r.created.length} file(s) ${verb} created`);
  if (r.updated.length) lines.push(`  ${r.updated.length} file(s) ${verb} updated: ${r.updated.join(", ")}`);
  if (r.restored.length) lines.push(`  ${r.restored.length} missing file(s) ${verb} restored: ${r.restored.join(", ")}`);
  if (r.forced.length) lines.push(`  ${r.forced.length} locally modified file(s) ${verb} overwritten (backup next to each): ${r.forced.join(", ")}`);
  if (!changedCount(r)) lines.push(`  ${r.unchanged} shipped file(s) up to date`);
  for (const c of r.conflicts) lines.push(`  CONFLICT ${c.path}: ${c.reason}`);
  if (r.conflicts.length) {
    lines.push("  Resolve by merging by hand, or run: openmem init --force (keeps a .bak copy)");
  }
  for (const o of r.orphans) lines.push(`  note: ${o} is no longer shipped; left in place`);
  return lines;
}
