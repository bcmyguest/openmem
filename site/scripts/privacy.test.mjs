import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { scanDir } from './lib/dist-scan.mjs';
import { applyAllowlist, codeRanges, formatFinding, scanText, validateAllowlist } from './lib/privacy.mjs';

const rules = (text, opts) => scanText(text, opts).map((f) => f.rule);

test('flags home, macOS, and Windows user paths', () => {
  assert.deepEqual(rules('see /home/alice/project'), ['home-path']);
  assert.deepEqual(rules('see /Users/alice/project'), ['macos-user-path']);
  assert.deepEqual(rules('see C:\\Users\\alice\\project'), ['windows-user-path']);
});

test('flags docker host alias, private IPs, LAN names, emails, operator box names', () => {
  assert.deepEqual(rules('http://host.docker.internal:11434'), ['docker-host']);
  assert.deepEqual(rules('bind 172.17.0.1:8888'), ['private-ip-172']);
  assert.deepEqual(rules('10.0.0.5'), ['private-ip-10']);
  assert.deepEqual(rules('192.168.1.20'), ['private-ip-192']);
  assert.deepEqual(rules('100.101.102.103'), ['cgnat-ip']);
  assert.deepEqual(rules('http://nas.local/x'), ['lan-hostname']);
  assert.deepEqual(rules('mail me at a.b@example.com'), ['email']);
  assert.deepEqual(rules('runs on box d'), ['operator-box']);
  assert.deepEqual(rules('runs on "Box D"'), ['operator-box']);
});

test('does not flag public addresses, loopback, or unrelated words', () => {
  assert.deepEqual(rules('127.0.0.1:8888 and 8.8.8.8 and 172.32.0.1 and unbox dev'), []);
});

test('flags env-style secret assignments but not placeholders', () => {
  assert.deepEqual(rules('LITELLM_MASTER_KEY=abc123'), ['secret-assignment']);
  assert.deepEqual(rules('API_KEY=abc123'), ['secret-assignment']);
  assert.deepEqual(rules('TOKEN=abc123'), ['secret-assignment']);
  assert.deepEqual(rules('export HINDSIGHT_API_LLM_API_KEY="abc123"'), ['secret-assignment']);
  assert.deepEqual(rules('API_KEY='), ['secret-assignment']);
  for (const ok of ['ANTHROPIC_API_KEY=...', 'API_KEY=<your-key>', 'TOKEN=$TOKEN', 'KEY=val', 'API_KEY=replace-me', 'API_KEY=${API_KEY}']) {
    assert.deepEqual(rules(ok), [], ok);
  }
  // A max-token setting is not a secret.
  assert.deepEqual(rules('HINDSIGHT_API_RETAIN_MAX_COMPLETION_TOKENS=16384'), []);
});

test('flags well-known secret shapes', () => {
  assert.deepEqual(rules(`sk-${'a'.repeat(32)}`), ['openai-style-key']);
  assert.deepEqual(rules(`ghp_${'A'.repeat(36)}`), ['github-token']);
  assert.deepEqual(rules('AKIAABCDEFGHIJKLMNOP'), ['aws-key']);
  assert.deepEqual(rules('-----BEGIN RSA PRIVATE KEY-----'), ['private-key']);
});

test('never prints a secret value', () => {
  const [f] = scanText('LITELLM_MASTER_KEY=hunter2hunter2', { file: 'a.md' });
  const line = formatFinding(f);
  assert.match(line, /LITELLM_MASTER_KEY=<redacted>/);
  assert.doesNotMatch(line, /hunter2/);
});

test('deny-list literals match case-insensitively and are redacted', () => {
  const f = scanText('Contact Zed Quux today', { deny: ['zed quux'] });
  assert.equal(f.length, 1);
  assert.equal(f[0].rule, 'deny-list');
  assert.match(formatFinding(f[0]), /<redacted>/);
  assert.doesNotMatch(formatFinding(f[0]), /zed quux/i);
});

test('reports line numbers', () => {
  const [f] = scanText('a\nb\n/home/x\n');
  assert.equal(f.line, 3);
});

test('codeRanges: html pre, code, and data-code attributes', () => {
  const html = '<p>x /home/a</p><pre><code>/home/example</code></pre><button data-code="/home/c">';
  const found = scanText(html, { kind: 'html' }).map((f) => [f.match, f.inCode]);
  assert.deepEqual(found, [['/home/a', false], ['/home/example', true], ['/home/c', true]]);
  assert.equal(codeRanges('<p>none</p>', 'html').length, 0);
});

test('codeRanges: markdown fences and inline code', () => {
  const md = 'prose /home/a\n\n```sh\n/home/example\n```\n\nand `/home/c` here\n';
  const found = scanText(md, { kind: 'md' }).map((f) => [f.match, f.inCode]);
  assert.deepEqual(found, [['/home/a', false], ['/home/example', true], ['/home/c', true]]);
});

test('allowlist covers only code matches, never prose', () => {
  const allow = validateAllowlist([
    { rule: 'docker-host', match: 'host.docker.internal', files: ['docs/a.md'], reason: 'generic docker alias in a config sample' },
  ]);
  const md = 'prose host.docker.internal\n\n```yaml\nurl: http://host.docker.internal:1\n```\n';
  const { blocking, allowed } = applyAllowlist(scanText(md, { kind: 'md', file: 'docs/a.md' }), allow);
  assert.equal(allowed.length, 1);
  assert.equal(blocking.length, 1);
  assert.equal(blocking[0].inCode, false);
});

test('allowlist is scoped to its files and exact match', () => {
  const allow = validateAllowlist([
    { rule: 'home-path', match: '/home/runner', files: ['docs/a.md'], reason: 'CI runner path in a log sample' },
  ]);
  const md = '```\n/home/runner and /home/alice\n```';
  const here = applyAllowlist(scanText(md, { kind: 'md', file: 'docs/a.md' }), allow);
  assert.deepEqual(here.blocking.map((f) => f.match), ['/home/alice']);
  const other = applyAllowlist(scanText(md, { kind: 'md', file: 'docs/b.md' }), allow);
  assert.equal(other.blocking.length, 2);
});

test('allowlist rejects malformed entries, missing reasons, and secret rules', () => {
  const good = { rule: 'docker-host', match: 'host.docker.internal', files: ['x'], reason: 'long enough reason' };
  assert.throws(() => validateAllowlist([{ ...good, reason: '' }]), /reason/);
  assert.throws(() => validateAllowlist([{ ...good, rule: 'nope' }]), /unknown rule/);
  assert.throws(() => validateAllowlist([{ ...good, files: [] }]), /files/);
  assert.throws(() => validateAllowlist([{ ...good, match: '' }]), /match/);
  assert.throws(() => validateAllowlist([{ ...good, rule: 'secret-assignment', match: 'API_KEY=x' }]), /secret rules/);
  assert.throws(() => validateAllowlist({}), /array/);
});

test('unused allowlist entries are reported', () => {
  const allow = validateAllowlist([{ rule: 'home-path', match: '/home/x', files: ['docs/a.md'], reason: 'long enough reason' }]);
  assert.equal(applyAllowlist([], allow).unused.length, 1);
});

test('scanDir fixture: finds leaks in dist, passes a clean tree, exempts pagefind emails only', () => {
  const dirty = mkdtempSync(join(tmpdir(), 'pm-dist-'));
  mkdirSync(join(dirty, 'pagefind'));
  writeFileSync(join(dirty, 'index.html'), '<p>path /home/alice/x</p><pre><code>LITELLM_MASTER_KEY=abc123</code></pre>');
  writeFileSync(join(dirty, 'pagefind', 'pagefind-ui.js'), '// credit someone@example.org\nconst h="host.docker.internal"');
  const { files, findings } = scanDir(dirty);
  assert.equal(files, 2);
  assert.deepEqual(
    findings.map((f) => `${f.file}:${f.rule}`).sort(),
    ['dist/index.html:home-path', 'dist/index.html:secret-assignment', 'dist/pagefind/pagefind-ui.js:docker-host'].sort(),
  );

  const clean = mkdtempSync(join(tmpdir(), 'pm-dist-'));
  writeFileSync(join(clean, 'index.html'), '<p>Hindsight on 127.0.0.1:8888, config in ~/.config/personal-memory</p>');
  assert.deepEqual(scanDir(clean).findings, []);
});
