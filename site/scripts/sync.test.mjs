import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { readProviders } from './lib/manifests.mjs';
import { runSync } from './lib/sync.mjs';

const write = (root, files) => {
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
};

const manifest = (id, status, extra = {}) => ({ id, label: id.toUpperCase(), status, ...extra });

const DOCS = {
  'docs/memory-providers.md': '# Providers\n\nSee [config](personal-memory-config.md) and [skill](../.agents/s/SKILL.md).\n',
  'docs/provider-wizard-hooks.md': '# Hooks\n\nBody.\n',
  'docs/personal-memory-config.md': '# Config\n\nBody.\n',
  '.agents/s/SKILL.md': 'x',
};

function fixture({ docs = DOCS, manifests = { a: manifest('a', 'supported') } } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'pm-repo-'));
  const site = mkdtempSync(join(tmpdir(), 'pm-site-'));
  write(repo, docs);
  for (const [id, m] of Object.entries(manifests)) write(repo, { [`providers/${id}/manifest.json`]: m });
  write(site, { 'src/content/docs/docs/getting-started.md': '---\ntitle: g\n---\n' });
  return { repo, site };
}
const opts = (f) => ({ repoRoot: f.repo, siteRoot: f.site, repoUrl: 'https://github.com/o/r', branch: 'main' });

test('generates pages and rewrites links; an absent optional doc is skipped', () => {
  const f = fixture();
  const { pages } = runSync(opts(f));
  assert.deepEqual(pages.map((p) => p.slug), ['getting-started', 'provider-status', 'memory-providers', 'provider-wizard-hooks', 'personal-memory-config']);
  const out = readFileSync(join(f.site, 'src/content/docs/docs/memory-providers.md'), 'utf8');
  assert.match(out, /\[config\]\(\.\.\/personal-memory-config\/\)/);
  assert.match(out, /\[skill\]\(https:\/\/github\.com\/o\/r\/blob\/main\/\.agents\/s\/SKILL\.md\)/);
  assert.doesNotMatch(out, /^# Providers/m);
  assert.equal(existsSync(join(f.site, 'src/content/docs/docs/npx-install.md')), false);
});

test('picks up docs/npx-install.md when it exists and uses its heading', () => {
  const f = fixture({ docs: { ...DOCS, 'docs/npx-install.md': '# Run it with npx\n\nBody.\n' } });
  const { pages } = runSync(opts(f));
  assert.equal(pages.find((p) => p.slug === 'npx-install').title, 'Run it with npx');
  const docsJson = JSON.parse(readFileSync(join(f.site, 'src/generated/docs.json'), 'utf8'));
  assert.deepEqual(docsJson.slice(0, 2).map((p) => p.slug), ['getting-started', 'npx-install']);
});

test('a privacy finding in a published doc fails the build and lists it, without redacting', () => {
  const f = fixture({ docs: { ...DOCS, 'docs/provider-wizard-hooks.md': '# Hooks\n\nRuns on box d at /home/alice/x\n\nLITELLM_MASTER_KEY=hunter2\n' } });
  assert.throws(
    () => runSync(opts(f)),
    (e) => {
      assert.match(e.message, /3 finding\(s\)/);
      assert.match(e.message, /docs\/provider-wizard-hooks\.md:3\s+\[home-path\]/);
      assert.match(e.message, /\[operator-box\]/);
      assert.match(e.message, /LITELLM_MASTER_KEY=<redacted>/);
      assert.doesNotMatch(e.message, /hunter2/);
      return true;
    },
  );
});

test('an allowlist entry admits a code match but not the same string in prose', () => {
  const f = fixture({ docs: { ...DOCS, 'docs/provider-wizard-hooks.md': '# Hooks\n\n`host.docker.internal`\n' } });
  write(f.site, {
    'scripts/privacy-allowlist.json': [{ rule: 'docker-host', match: 'host.docker.internal', files: ['docs/provider-wizard-hooks.md'], reason: 'generic docker alias, documented' }],
  });
  assert.doesNotThrow(() => runSync(opts(f)));
  write(f.repo, { 'docs/provider-wizard-hooks.md': '# Hooks\n\nplain host.docker.internal prose\n' });
  assert.throws(() => runSync(opts(f)), /docker-host/);
});

test('a broken relative link fails the build', () => {
  const f = fixture({ docs: { ...DOCS, 'docs/provider-wizard-hooks.md': '# Hooks\n\n[x](gone.md)\n' } });
  assert.throws(() => runSync(opts(f)), /docs\/gone\.md/);
});

test('a missing required doc fails the build', () => {
  const docs = { ...DOCS, 'docs/memory-providers.md': '# Providers\n\nBody.\n' };
  delete docs['docs/personal-memory-config.md'];
  assert.throws(() => runSync(opts(fixture({ docs }))), /required doc source is missing/);
});

test('manifests: status comes only from the file, and bad values are rejected', () => {
  const f = fixture({
    manifests: {
      a: manifest('a', 'supported', { compose: { services: ['x'], defaultHostPort: 1, hostPortEnv: 'A_PORT' }, settings: { nativeDocs: 'https://a.dev/' } }),
      b: manifest('b', 'planned', { settings: { nativeDocs: 'javascript:alert(1)' } }),
    },
  });
  const providers = readProviders(join(f.repo, 'providers'));
  assert.deepEqual(providers.map((p) => [p.id, p.status]), [['a', 'supported'], ['b', 'planned']]);
  assert.match(providers[0].selfHost, /Docker Compose services: x\. Default host port 1 \(A_PORT\)/);
  assert.equal(providers[1].nativeDocs, null);
  assert.match(providers[1].selfHost, /Not wired yet/);

  assert.throws(() => readProviders(join(fixture({ manifests: { c: manifest('c', 'stable') } }).repo, 'providers')), /status "stable"/);
  assert.throws(() => readProviders(join(fixture({ manifests: { d: manifest('other', 'planned') } }).repo, 'providers')), /does not match its directory/);
});

test('the status page lists every provider with its manifest status', () => {
  const f = fixture({ manifests: { a: manifest('a', 'supported'), m: manifest('m', 'experimental') } });
  runSync(opts(f));
  const page = readFileSync(join(f.site, 'src/content/docs/docs/provider-status.md'), 'utf8');
  assert.match(page, /\| A \| Supported \|/);
  assert.match(page, /\| M \| Experimental \|/);
});
