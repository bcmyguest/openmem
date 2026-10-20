/**
 * The mem0 env file (default ~/.config/personal-memory/mem0.env): the indexer's MEM0_API_KEY,
 * mode 600 in a mode 700 directory, outside the repo. Nothing here prints a key.
 */
import fs from "node:fs";
import path from "node:path";

const KEY_LINE = /^\s*(?:export\s+)?MEM0_API_KEY\s*=/;

/**
 * The key must survive an env_file parser (compose interpolates '$', treats '#' and quotes
 * specially) and a single line. The message never echoes the key.
 * @param {string} key
 * @returns {string} problem text, or ""
 */
export function keyProblem(key) {
  if (/[\x00-\x20\x7f"'`#$\\]/.test(key)) {
    return "the API key has characters an env file cannot hold safely (whitespace, quotes, '#', '$', backslash)";
  }
  return "";
}

/**
 * The MEM0_API_KEY value in the file (the last such line), or "".
 * @param {string} file
 */
export function readKey(file) {
  if (!fs.existsSync(file)) return "";
  let value = "";
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (KEY_LINE.test(line)) value = line.slice(line.indexOf("=") + 1).trim();
  }
  return value;
}

/** @param {string} file @returns {number} permission bits, or -1 when the file is absent */
export function fileMode(file) {
  return fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : -1;
}

/** True when group or others can read or write the file. */
export function tooOpen(file) {
  const mode = fileMode(file);
  return mode >= 0 && (mode & 0o077) !== 0;
}

/**
 * Write `MEM0_API_KEY=<key>` into the file: other lines are kept, an existing key line is
 * replaced. The directory is created with mode 700 and the file is replaced atomically
 * with mode 600 (a temp file beside it, so the key is never briefly world-readable).
 * @param {string} file
 * @param {string} key
 * @returns {"created"|"updated"|"unchanged"}
 */
export function writeKey(file, key) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Write through a symlink instead of replacing it.
  const target = fs.existsSync(file) ? fs.realpathSync(file) : file;
  const existed = fs.existsSync(target);
  /** @type {string[]} */
  let lines = [];
  if (existed) {
    lines = fs.readFileSync(target, "utf8").split(/\r?\n/);
    while (lines.length && lines.at(-1) === "") lines.pop();
  }
  const kept = lines.filter((l) => !KEY_LINE.test(l));
  const text = `${[...kept, `MEM0_API_KEY=${key}`].join("\n")}\n`;
  if (existed && fs.readFileSync(target, "utf8") === text && !tooOpen(target)) return "unchanged";
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, target);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return existed ? "updated" : "created";
}
