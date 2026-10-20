/**
 * Read one key from an env file the way docker compose's env_file loader does, so the key the
 * wizard checks is the key the indexer container gets. Node builtins only: scripts/setup.mjs
 * loads this through stack-env.mjs, without the wizard helpers.
 *
 * Rules (verified against `docker compose config`): an optional `export ` prefix and
 * whitespace around the key and the `=`; CRLF line ends; a value starting with " or ' reads
 * up to the matching quote (anything after it is ignored); otherwise leading whitespace is
 * dropped, the value stops at a space followed by `#` (a tab or a leading `#` does not start a
 * comment) and is trimmed; the last duplicate wins; an unterminated quote
 * reads as empty (compose refuses to load such a file).
 */

/** @param {string} s */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The value after `=`.
 * @param {string} rest
 * @returns {string}
 */
function parseValue(rest) {
  const trimmed = rest.replace(/^\s+/, "");
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    let out = "";
    for (let i = 1; i < trimmed.length; i++) {
      const c = trimmed[i];
      if (quote === '"' && c === "\\" && i + 1 < trimmed.length) {
        const next = trimmed[i + 1];
        if (next === '"' || next === "\\") {
          out += next;
          i++;
          continue;
        }
      }
      if (c === quote) return out;
      out += c;
    }
    return "";
  }
  return trimmed.replace(/ #.*$/, "").trim();
}

/**
 * The value of `key` in env file text: the last matching line, "" when absent or empty.
 * @param {string} text
 * @param {string} key
 * @returns {string}
 */
export function parseEnvValue(text, key) {
  const line = new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(key)}\\s*=(.*)$`);
  let value = "";
  for (const raw of String(text).split(/\r?\n/)) {
    const m = line.exec(raw.replace(/\r$/, ""));
    if (m) value = parseValue(m[1]);
  }
  return value;
}

/**
 * True when any line assigns `key` (even to an empty value).
 * @param {string} text
 * @param {string} key
 */
export function assignsKey(text, key) {
  const line = new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(key)}\\s*=`);
  return String(text).split(/\r?\n/).some((l) => line.test(l));
}
