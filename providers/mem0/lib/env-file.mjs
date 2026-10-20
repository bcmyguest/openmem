/**
 * The mem0 env file (default ~/.config/personal-memory/mem0.env): the indexer's MEM0_API_KEY,
 * mode 600 in a mode 700 directory, outside the repo. Nothing here prints a key. Reads follow
 * docker compose's env_file rules (see dotenv.mjs) so the wizard sees the key the indexer gets.
 */
import fs from "node:fs";
import path from "node:path";
import { parseEnvValue } from "./dotenv.mjs";

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
 * The MEM0_API_KEY value compose would load from the file (last duplicate wins, quotes and
 * `export` handled), or "" when the file is absent, has no such line, or the value is empty.
 * @param {string} file
 */
export function readKey(file) {
  if (!fs.existsSync(file)) return "";
  return parseEnvValue(fs.readFileSync(file, "utf8"), "MEM0_API_KEY");
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
 * True when the file's directory exists and group or others can enter or list it. The file
 * mode still protects the key; this is the extra hygiene the wizard warns about.
 * @param {string} file
 */
export function dirTooOpen(file) {
  const dir = path.dirname(file);
  return fs.existsSync(dir) && (fs.statSync(dir).mode & 0o077) !== 0;
}

/**
 * Follow a chain of symlinks (also dangling ones) to the path that would hold the data.
 * @param {string} p
 */
function resolveLink(p) {
  let current = p;
  for (let i = 0; i < 16; i++) {
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return current;
    }
    if (!stat.isSymbolicLink()) return current;
    current = path.resolve(path.dirname(current), fs.readlinkSync(current));
  }
  throw new Error("too many symbolic links in the mem0 env file path");
}

/**
 * Write `MEM0_API_KEY=<key>` into the file: other lines are kept, every existing key line is
 * replaced by one. A symlinked file or directory keeps its link and the data lands at the
 * target. The directory is created with mode 700; the file is replaced atomically through a
 * temp file created exclusively (`wx`) with mode 600 beside it, so the key is never briefly
 * readable by others.
 * @param {string} file
 * @param {string} key
 * @returns {"created"|"updated"|"unchanged"}
 */
export function writeKey(file, key) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const target = resolveLink(path.join(fs.realpathSync(path.dirname(file)), path.basename(file)));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const existed = fs.existsSync(target);
  /** @type {string[]} */
  let lines = [];
  let previous = "";
  if (existed) {
    previous = fs.readFileSync(target, "utf8");
    lines = previous.split(/\r?\n/);
    while (lines.length && lines.at(-1) === "") lines.pop();
  }
  const kept = lines.filter((l) => !KEY_LINE.test(l));
  const text = `${[...kept, `MEM0_API_KEY=${key}`].join("\n")}\n`;
  if (existed && previous === text && !tooOpen(target)) return "unchanged";
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    fs.writeFileSync(tmp, text, { flag: "wx", mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, target);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return existed ? "updated" : "created";
}
