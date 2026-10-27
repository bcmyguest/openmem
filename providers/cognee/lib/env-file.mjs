/**
 * Small dotenv-style file helpers for Cognee's operator env files. They read and replace
 * KEY=value lines and leave every other line (comments, blank lines, unrelated keys) alone.
 * Nothing here logs; callers print key NAMES and paths only.
 */
import fs from "node:fs";
import path from "node:path";

const KEY_RE = /^[A-Z][A-Z0-9_]*$/;

/**
 * The value of one assignment as Docker Compose reads it: a double-quoted value has `\\`, `\"`
 * and `\$` unescaped (the escapes formatValue writes), a single-quoted value is literal, and
 * anything else is taken as is.
 * @param {string} raw the text after `=`
 */
function unquote(raw) {
  const dq = /^"(.*)"$/.exec(raw);
  if (dq) return dq[1].replace(/\\(["\\$])/g, "$1");
  const sq = /^'(.*)'$/.exec(raw);
  if (sq) return sq[1];
  return raw;
}

/**
 * Parse a dotenv-style text. Parsing is line-based: a value never spans lines (formatValue
 * refuses to write one), so a line that merely looks like an assignment is an assignment.
 * Accepts `export KEY=value` and CRLF line ends; the last assignment of a key wins.
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function parseEnvText(text) {
  /** @type {Map<string, string>} */
  const values = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    values.set(key, unquote(line.slice(eq + 1).trim()));
  }
  return values;
}

/**
 * @param {string} file
 * @returns {{ exists: boolean, text: string, values: Map<string, string>, error: string }}
 *   `error` is set when the file exists but cannot be read
 */
export function readEnvFile(file) {
  if (!fs.existsSync(file)) return { exists: false, text: "", values: new Map(), error: "" };
  try {
    const text = fs.readFileSync(file, "utf8");
    return { exists: true, text, values: parseEnvText(text), error: "" };
  } catch (e) {
    return {
      exists: true,
      text: "",
      values: new Map(),
      error: /** @type {NodeJS.ErrnoException} */ (e).code || "unreadable",
    };
  }
}

/**
 * True when the file grants any permission to group or others.
 * @param {string} file
 */
export function tooOpen(file) {
  return (fs.statSync(file).mode & 0o077) !== 0;
}

/**
 * Render one value so Docker Compose's env_file parser reads it back unchanged: plain when
 * it only has safe characters, single-quoted (literal, no interpolation) when it has no
 * single quote and does not end in a backslash (Compose reads `\'` as an unterminated
 * quote), double-quoted with `\`, `"` and `$` escaped otherwise.
 * @param {string} value
 */
export function formatValue(value) {
  if (/[\r\n\0]/.test(value)) throw new Error("env values must be a single line");
  if (/^[A-Za-z0-9_.:/@%+=,-]*$/.test(value)) return value;
  if (!value.includes("'") && !value.endsWith("\\")) return `'${value}'`;
  return `"${value.replace(/[\\"$]/g, "\\$&")}"`;
}

/**
 * Replace the given keys in `text` (first assignment replaced in place, later duplicates
 * dropped) and append the ones that were absent. Every other line is kept byte for byte.
 * @param {string} text
 * @param {Record<string, string>} updates
 * @returns {string}
 */
export function mergeEnvText(text, updates) {
  for (const key of Object.keys(updates)) {
    if (!KEY_RE.test(key)) throw new Error(`invalid env key: ${key}`);
  }
  const pending = new Map(Object.entries(updates));
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  for (const raw of lines) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(raw);
    const key = m?.[1];
    if (key && pending.has(key)) {
      if (!seen.has(key)) {
        seen.add(key);
        out.push(`${key}=${formatValue(/** @type {string} */ (pending.get(key)))}`);
      }
      continue;
    }
    out.push(raw);
  }
  for (const [key, value] of pending) {
    if (!seen.has(key)) out.push(`${key}=${formatValue(value)}`);
  }
  return `${out.join("\n")}\n`;
}

/**
 * Remove assignment lines for the given keys (first and duplicate assignments). Other
 * lines are kept. Used when switching presets so stale values (e.g. EMBEDDING_ENDPOINT
 * after moving to FastEmbed) do not linger.
 * @param {string} text
 * @param {string[]} keys
 * @returns {string}
 */
export function dropEnvKeys(text, keys) {
  const drop = new Set(keys);
  for (const key of drop) {
    if (!KEY_RE.test(key)) throw new Error(`invalid env key: ${key}`);
  }
  if (!drop.size) return text.endsWith("\n") || text === "" ? text : `${text}\n`;
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const out = lines.filter((raw) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(raw);
    return !(m && drop.has(m[1]));
  });
  return out.length ? `${out.join("\n")}\n` : "";
}

/**
 * Create `dir` (and missing parents) with mode 0700.
 * @param {string} dir
 * @returns {boolean} whether the directory had to be created
 */
export function ensurePrivateDir(dir) {
  if (fs.existsSync(dir)) return false;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return true;
}

/**
 * Where a write to `file` really lands: the target of a symlink (a dotfile-managed link
 * keeps pointing at its file), including a link whose target does not exist yet.
 * @param {string} file
 */
export function writeTarget(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    try {
      if (fs.lstatSync(file).isSymbolicLink()) {
        return path.resolve(path.dirname(file), fs.readlinkSync(file));
      }
    } catch {
      // not there at all: write the path itself
    }
    return file;
  }
}

/**
 * Write `text` to `file` with mode 0600 (temp file in the same directory, then rename, so
 * a reader never sees a partial file and the old mode is never kept). A symlink is
 * followed: the target is replaced and the link stays.
 * @param {string} file
 * @param {string} text
 */
export function writePrivateFile(file, text) {
  const target = writeTarget(file);
  ensurePrivateDir(path.dirname(target));
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, target);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}
