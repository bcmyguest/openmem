// Privacy rules shared by the build-time source scan (sync.mjs) and the dist/
// scan (check-privacy.mjs). Pure functions only, so the unit tests need no
// build output.
//
// A finding is a rule match. Matches inside code (HTML <pre>/<code>, Markdown
// fences and inline code) may be allowed by an explicit allowlist entry that
// names the rule, the exact match, the files it covers, and a reason. Matches
// in prose are never allowed. Nothing is redacted or stripped silently: a
// finding fails the build.

/** @typedef {{ id: string, label: string, re: RegExp, secret?: boolean, accept?: (m: RegExpExecArray) => boolean }} Rule */

const PLACEHOLDER_VALUE =
  /^(?:\.{2,}|\u2026|\*+|x{3,}|<.*|\$.*|val(?:ue)?|your[-_].*|replace[-_]?me|change[-_]?me|example.*|redacted|todo|none|null|true|false)$/i;

/** @type {Rule[]} */
export const RULES = [
  { id: 'home-path', label: 'home directory path', re: /\/home\/[A-Za-z0-9._-]+/g },
  { id: 'macos-user-path', label: 'macOS user path', re: /\/Users\/[A-Za-z0-9._-]+/g },
  { id: 'windows-user-path', label: 'Windows user path', re: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/g },
  { id: 'docker-host', label: 'host.docker.internal (identifies the operator host setup)', re: /\bhost\.docker\.internal\b/gi },
  { id: 'private-ip-10', label: 'private IPv4 (10/8)', re: /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g },
  { id: 'private-ip-192', label: 'private IPv4 (192.168/16)', re: /\b192\.168\.\d{1,3}\.\d{1,3}\b/g },
  { id: 'private-ip-172', label: 'private IPv4 (172.16/12)', re: /\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/g },
  { id: 'cgnat-ip', label: 'carrier-grade NAT IPv4 (100.64/10, e.g. tailnet)', re: /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g },
  { id: 'link-local-ip', label: 'link-local IPv4', re: /\b169\.254\.\d{1,3}\.\d{1,3}\b/g },
  { id: 'email', label: 'email address', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g },
  { id: 'lan-hostname', label: 'LAN hostname', re: /\b[A-Za-z0-9-]+\.(?:local|lan|home\.arpa|localdomain|ts\.net)\b/gi },
  { id: 'operator-box', label: 'operator-specific machine name', re: /\bbox\s+["'`\u201c]?d["'`\u201d]?(?![\w-])/gi },
  {
    id: 'secret-assignment',
    label: 'env-style secret assignment (KEY=value)',
    re: /\b[A-Z0-9_]*(?:API_KEY|MASTER_KEY|SECRET_KEY|ACCESS_KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD)[ \t]*=[ \t]*(["']?)([^\s"'`]*)/g,
    secret: true,
    // Explicit placeholders (`=...`, `=<token>`, `=$VAR`, `=replace-me`) are documentation.
    // A bare `KEY=` with nothing after it is flagged: write a placeholder instead.
    accept: (m) => !PLACEHOLDER_VALUE.test(m[2]),
  },
  { id: 'openai-style-key', label: 'API key shape (sk-...)', re: /\bsk-[A-Za-z0-9_-]{20,}/g, secret: true },
  { id: 'github-token', label: 'GitHub token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}/g, secret: true },
  { id: 'aws-key', label: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/g, secret: true },
  { id: 'slack-token', label: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, secret: true },
  { id: 'jwt', label: 'JSON web token', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, secret: true },
  { id: 'private-key', label: 'PEM private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, secret: true },
];

/**
 * Character ranges that are code, not prose.
 * @param {string} text
 * @param {'html' | 'md' | 'text'} kind
 * @returns {Array<[number, number]>}
 */
export function codeRanges(text, kind) {
  /** @type {Array<[number, number]>} */
  const ranges = [];
  if (kind === 'html') {
    for (const re of [/<pre\b[\s\S]*?<\/pre>/gi, /<code\b[\s\S]*?<\/code>/gi, /\sdata-(?:code|copy)="[^"]*"/gi]) {
      for (const m of text.matchAll(re)) ranges.push([m.index, m.index + m[0].length]);
    }
  } else if (kind === 'md') {
    let offset = 0;
    let fence = null;
    let fenceStart = 0;
    for (const line of text.split('\n')) {
      const f = /^\s*(`{3,}|~{3,})/.exec(line);
      if (f) {
        if (fence === null) {
          fence = f[1][0];
          fenceStart = offset;
        } else if (f[1][0] === fence) {
          ranges.push([fenceStart, offset + line.length]);
          fence = null;
        }
      } else if (fence === null) {
        for (const m of line.matchAll(/(`+)[^`\n]*?\1/g)) ranges.push([offset + m.index, offset + m.index + m[0].length]);
      }
      offset += line.length + 1;
    }
    if (fence !== null) ranges.push([fenceStart, text.length]);
  }
  return ranges;
}

const inRanges = (ranges, index) => ranges.some(([a, b]) => index >= a && index < b);

/**
 * @param {string} text
 * @param {{ kind?: 'html' | 'md' | 'text', file?: string, deny?: string[], rules?: Rule[] }} [opts]
 * @returns {Array<{ file: string, rule: string, label: string, match: string, line: number, inCode: boolean, secret: boolean }>}
 */
export function scanText(text, { kind = 'text', file = '<input>', deny = [], rules = RULES } = {}) {
  const ranges = codeRanges(text, kind);
  const lineAt = (index) => text.slice(0, index).split('\n').length;
  const out = [];
  for (const rule of rules) {
    for (const m of text.matchAll(new RegExp(rule.re.source, rule.re.flags))) {
      if (rule.accept && !rule.accept(m)) continue;
      out.push({
        file,
        rule: rule.id,
        label: rule.label,
        match: m[0],
        line: lineAt(m.index),
        inCode: inRanges(ranges, m.index),
        secret: Boolean(rule.secret),
      });
    }
  }
  const lower = text.toLowerCase();
  for (const literal of deny) {
    const needle = literal.toLowerCase();
    for (let i = lower.indexOf(needle); i !== -1; i = lower.indexOf(needle, i + needle.length)) {
      out.push({ file, rule: 'deny-list', label: 'deny-list literal', match: literal, line: lineAt(i), inCode: inRanges(ranges, i), secret: true });
    }
  }
  return out;
}

/**
 * Validate allowlist entries. Throws on a malformed entry so a typo cannot
 * silently widen the exemption.
 * @param {unknown} entries
 */
export function validateAllowlist(entries) {
  if (!Array.isArray(entries)) throw new Error('privacy allowlist must be an array');
  const ruleIds = new Set(RULES.map((r) => r.id));
  entries.forEach((e, i) => {
    const where = `privacy allowlist entry ${i}`;
    if (!e || typeof e !== 'object') throw new Error(`${where}: not an object`);
    if (!ruleIds.has(e.rule)) throw new Error(`${where}: unknown rule "${e.rule}"`);
    if (typeof e.match !== 'string' || !e.match) throw new Error(`${where}: "match" must be the exact matched string`);
    if (!Array.isArray(e.files) || !e.files.length || e.files.some((f) => typeof f !== 'string' || !f)) {
      throw new Error(`${where}: "files" must list at least one path prefix`);
    }
    if (typeof e.reason !== 'string' || e.reason.trim().length < 10) throw new Error(`${where}: "reason" is required`);
    if (RULES.find((r) => r.id === e.rule)?.secret) throw new Error(`${where}: secret rules cannot be allowlisted`);
  });
  return entries;
}

/**
 * Split findings into blocking ones and allowed ones. An entry only covers
 * matches that sit inside code, never prose.
 */
export function applyAllowlist(findings, allowlist) {
  const used = new Set();
  const blocking = [];
  const allowed = [];
  for (const f of findings) {
    const idx = allowlist.findIndex(
      (e) => e.rule === f.rule && e.match === f.match && f.inCode && e.files.some((p) => f.file === p || f.file.startsWith(p)),
    );
    if (idx === -1) blocking.push(f);
    else {
      allowed.push(f);
      used.add(idx);
    }
  }
  const unused = allowlist.filter((_, i) => !used.has(i));
  return { blocking, allowed, unused };
}

/** Never print a secret match; show the rule and the variable name only. */
export function formatFinding(f) {
  let shown = f.match;
  if (f.secret) {
    const name = /^([A-Z0-9_]+)\s*=/.exec(f.match)?.[1];
    shown = name ? `${name}=<redacted>` : '<redacted>';
  }
  return `  ${f.file}:${f.line}  [${f.rule}]  ${shown}${f.inCode ? '  (in code)' : ''}`;
}
