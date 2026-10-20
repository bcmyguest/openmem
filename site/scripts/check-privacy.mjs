// Fails (exit 1) if the built site or a published doc source leaks personal or
// environment details.
//
//   node scripts/check-privacy.mjs [dir=dist]   scan dist/ and the published doc sources
//   node scripts/check-privacy.mjs --sources-report
//                                               list findings across the wider repo docs
//                                               (advisory: never fails, for the integrator)
//
// Rules live in scripts/lib/privacy.mjs. A match in code may be allowed by an
// entry in scripts/privacy-allowlist.json (rule, exact match, files, reason).
// Prose matches are never allowed. Add personal literals (names, machine
// names) one per line to .privacy-deny.local (gitignored) or PRIVACY_DENY
// (comma-separated). Nothing is redacted or stripped; findings fail the build.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGES } from './lib/docs.mjs';
import { scanDir } from './lib/dist-scan.mjs';
import { loadPrivacyConfig } from './lib/sync.mjs';
import { applyAllowlist, formatFinding, scanText } from './lib/privacy.mjs';

const siteRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = process.env.PM_REPO_ROOT ?? fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);
const { allowlist, deny } = loadPrivacyConfig(siteRoot);

function* mdFiles(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.git')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* mdFiles(p);
    else if (/\.(md|example|toml|ya?ml|json|env)$/i.test(name)) yield p;
  }
}

if (args.includes('--sources-report')) {
  const files = [
    join(repoRoot, 'README.md'),
    ...mdFiles(join(repoRoot, 'docs')),
    ...mdFiles(join(repoRoot, '.agents')),
    ...mdFiles(join(repoRoot, 'providers')),
    ...mdFiles(join(repoRoot, 'config')).filter((f) => /\.example$/.test(f)),
  ].filter((f) => existsSync(f));
  const published = new Set(PAGES.filter((p) => p.source).map((p) => p.source));
  const findings = [];
  for (const f of files) {
    const rel = relative(repoRoot, f).split('\\').join('/');
    const kind = rel.endsWith('.md') ? 'md' : 'text';
    findings.push(...scanText(readFileSync(f, 'utf8'), { kind, file: rel, deny }));
  }
  const { blocking, allowed } = applyAllowlist(findings, allowlist);
  console.log(`check-privacy (advisory): ${files.length} repo files scanned, ${blocking.length} finding(s), ${allowed.length} allowlisted.`);
  for (const f of blocking) console.log(formatFinding(f) + (published.has(f.file) ? '  <- PUBLISHED' : ''));
  process.exit(0);
}

const dir = args.find((a) => !a.startsWith('--')) ?? 'dist';
if (!existsSync(dir)) {
  console.error(`check-privacy: ${dir} does not exist; build first.`);
  process.exit(2);
}

const { files, findings } = scanDir(dir, { deny });
let sources = 0;
for (const page of PAGES) {
  if (page.kind !== 'doc') continue;
  const abs = join(repoRoot, page.source);
  if (!existsSync(abs)) continue;
  sources++;
  findings.push(...scanText(readFileSync(abs, 'utf8'), { kind: 'md', file: page.source, deny }));
}

const { blocking, allowed, unused } = applyAllowlist(findings, allowlist);
for (const e of unused) console.warn(`check-privacy: warning: allowlist entry not used (${e.rule} ${JSON.stringify(e.match)})`);
if (blocking.length) {
  console.error(`check-privacy: ${blocking.length} finding(s) in ${files} dist files and ${sources} doc sources:`);
  for (const f of blocking.slice(0, 80)) console.error(formatFinding(f));
  if (blocking.length > 80) console.error(`  ... and ${blocking.length - 80} more`);
  process.exit(1);
}
console.log(
  `check-privacy: OK (${files} dist text files, ${sources} doc sources, ${allowed.length} allowlisted code match(es), ${deny.length} deny-list literals)`,
);
