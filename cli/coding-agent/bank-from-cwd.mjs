import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function validGitEntry(root) {
  const entry = path.join(root, ".git");
  try {
    const stat = fs.statSync(entry);
    if (stat.isDirectory()) return fs.existsSync(path.join(entry, "HEAD")) && fs.existsSync(path.join(entry, "config"));
    if (!stat.isFile()) return false;
    const match = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(entry, "utf8"));
    if (!match) return false;
    const gitDir = path.resolve(root, match[1]);
    return fs.statSync(gitDir).isDirectory()
      && (fs.existsSync(path.join(gitDir, "HEAD")) || fs.existsSync(path.join(gitDir, "commondir")));
  } catch { return false; }
}

function projectRoot(cwd) {
  try {
    if (!fs.statSync(cwd).isDirectory()) return cwd;
  } catch { return cwd; }
  let candidate = cwd;
  while (true) {
    if (validGitEntry(candidate)) return candidate;
    const parent = path.dirname(candidate);
    if (parent === candidate) return cwd;
    candidate = parent;
  }
}

function projectName(root) {
  try {
    const gitEntry = path.join(root, ".git");
    const stat = fs.statSync(gitEntry);
    let gitDir = gitEntry;
    if (stat.isFile()) {
      const match = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(gitEntry, "utf8"));
      if (match) gitDir = path.resolve(root, match[1]);
    }
    const commonFile = path.join(gitDir, "commondir");
    const commonPath = fs.existsSync(commonFile)
      ? path.resolve(gitDir, fs.readFileSync(commonFile, "utf8").trim())
      : gitDir;
    // Only linked worktrees use a shared project's name. Submodules retain their own repository name.
    if (path.basename(path.dirname(gitDir)) === "worktrees" && path.basename(commonPath) === ".git") {
      return path.basename(path.dirname(commonPath));
    }
  } catch { /* non-git workspace */ }
  return path.basename(root);
}

function expandPrefix(prefix, home) {
  if (typeof prefix !== "string" || !prefix.trim()) return null;
  let expanded = prefix;
  if (prefix === "~" || prefix.startsWith("~/")) {
    expanded = prefix === "~" ? home : path.join(home, prefix.slice(2));
  } else if (prefix.startsWith("~")) {
    const slash = prefix.indexOf(path.sep);
    const username = slash < 0 ? prefix.slice(1) : prefix.slice(1, slash);
    if (!username) return null;
    let userHome = null;
    try {
      userHome = fs.readFileSync("/etc/passwd", "utf8").split(/\r?\n/)
        .map((line) => line.split(":"))
        .find((fields) => fields[0] === username)?.[5] || null;
    } catch { /* passwd is not available on every platform */ }
    if (!userHome && username === os.userInfo().username) userHome = home;
    if (!userHome) return null;
    expanded = slash < 0 ? userHome : path.join(userHome, prefix.slice(slash + 1));
  }
  if (!path.isAbsolute(expanded)) return null;
  return path.resolve(expanded);
}

function matchingBank(target, mappings, home) {
  if (!mappings || typeof mappings !== "object" || Array.isArray(mappings)) return null;
  return Object.entries(mappings)
    .filter(([prefix, bank]) => typeof bank === "string" && bank.trim() && expandPrefix(prefix, home))
    .map(([prefix, bank]) => [expandPrefix(prefix, home), bank.trim()])
    .filter(([prefix]) => target === prefix || target.startsWith(`${prefix}${path.sep}`))
    .sort(([a], [b]) => b.length - a.length)[0]?.[1] || null;
}

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function yamlBanks(file, home) {
  const source = fs.readFileSync(file, "utf8");
  const document = parseDocument(source, { uniqueKeys: true, version: "1.1" });
  if (document.errors.length) throw new Error(`${file}: ${document.errors[0].message}`);
  const data = document.toJS() ?? {};
  if (typeof data !== "object" || Array.isArray(data)) throw new Error(`${file}: expected a YAML mapping`);
  const banks = Object.hasOwn(data, "banks")
    ? data.banks
    : { "~/Documents/sample-project": "coding-agent::documents-sample-project" };
  if (!banks || typeof banks !== "object" || Array.isArray(banks)) throw new Error(`${file}: banks must be a mapping`);
  const result = {};
  for (const [key, value] of Object.entries(banks)) {
    if (typeof key !== "string" || !key.trim()) throw new Error(`${file}: banks key must be a non-empty string`);
    if (typeof value !== "string" || !value.trim()) throw new Error(`${file}: banks[${key}] must be a non-empty bank id string`);
    const prefix = expandPrefix(key, home);
    if (!prefix) throw new Error(`${file}: banks key must be an absolute path: ${key}`);
    result[prefix] = value;
  }
  return result;
}

function configuredBanks(home, env) {
  const override = env.HINDSIGHT_INDEX_CONFIG;
  const user = path.join(home, ".config", "hindsight", "index.yml");
  const configFile = override ? (expandPrefix(override, home) || path.resolve(override))
    : fs.existsSync(user) ? user : path.join(PKG_ROOT, "config", "index.yml");
  return yamlBanks(configFile, home);
}

/** Map a workspace cwd to the indexer's project bank. */
export function bankFromCwd(cwd, options = {}) {
  const dir = path.resolve(String(cwd || process.cwd()));
  const root = projectRoot(dir);
  const home = options.home || process.env.HOME || os.homedir();
  const env = options.env || process.env;
  const indexBanks = options.banks || configuredBanks(home, env);
  const personalConfig = readJson(path.join(home, ".config", "personal-memory", "coding-agent.json"));
  const legacyConfig = readJson(path.join(home, ".hindsight", "coding-agent.json"));
  const mappingTarget = root === dir ? dir : root;
  for (const mapping of [indexBanks, options.mapPathToBank || personalConfig.mapPathToBank, legacyConfig.mapPathToBank]) {
    const bank = matchingBank(mappingTarget, mapping, home);
    if (bank) return bank;
  }
  return `coding-agent::${projectName(root) || "workspace"}`;
}
