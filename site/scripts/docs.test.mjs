import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firstHeading, mapProse, pictureToDuo, rewriteLinks, stripH1, withFrontmatter } from './lib/docs.mjs';

test('pictureToDuo: site pictures become the theme duo with base-relative URLs', () => {
  const md = [
    'Before.',
    '<picture>',
    '<source media="(prefers-color-scheme: dark)" srcset="https://h.io/om/media/c-dark.png" />',
    '<img src="https://h.io/om/media/c.png" alt="Chart" />',
    '</picture>',
    '<picture>',
    '<source media="(prefers-color-scheme: dark)" srcset="https://other.io/x-dark.png" />',
    '<img src="https://other.io/x.png" alt="Other" />',
    '</picture>',
  ].join('\n');
  const out = pictureToDuo(md, { siteRoot: 'https://h.io/om/', basePath: '/om/' });
  assert.match(out, /<img class="pm-diagram-light" src="\/om\/media\/c\.png" alt="Chart" \/>/);
  assert.match(out, /<img class="pm-diagram-dark" src="\/om\/media\/c-dark\.png" alt="Chart" \/>/);
  assert.match(out, /src="https:\/\/other\.io\/x\.png"/, 'foreign URLs stay absolute');
  assert.doesNotMatch(out, /<picture>/);
  assert.equal(pictureToDuo('plain text', { siteRoot: 'https://h.io/om/', basePath: '/' }), 'plain text');
});

const ctx = {
  sourcePath: 'docs/a.md',
  published: new Map([['docs/b.md', 'b-page']]),
  kindOf: (p) => (['README.md', 'docs/c.md', '.agents/skills/x'].includes(p) ? (p.endsWith('x') ? 'dir' : 'file') : null),
  repoUrl: 'https://github.com/o/r',
  branch: 'main',
};

test('links to published docs become site-relative page links', () => {
  assert.equal(rewriteLinks('[B](b.md)', ctx), '[B](../b-page/)');
  assert.equal(rewriteLinks('[B](b.md#sec)', ctx), '[B](../b-page/#sec)');
});

test('links to other repo files become blob or tree URLs', () => {
  assert.equal(rewriteLinks('[R](../README.md)', ctx), '[R](https://github.com/o/r/blob/main/README.md)');
  assert.equal(rewriteLinks('[C](c.md#x)', ctx), '[C](https://github.com/o/r/blob/main/docs/c.md#x)');
  assert.equal(rewriteLinks('[S](../.agents/skills/x)', ctx), '[S](https://github.com/o/r/tree/main/.agents/skills/x)');
});

test('external, anchor, and absolute links are untouched', () => {
  const md = '[a](https://x.dev) [b](#top) [c](mailto:a@b.co) [d](//cdn.x/y)';
  assert.equal(rewriteLinks(md, ctx), md);
  assert.equal(
    rewriteLinks('![diagram](/openmem/diagrams/architecture-1.svg)', ctx),
    '![diagram](/openmem/diagrams/architecture-1.svg)',
  );
});

test('links inside code are untouched', () => {
  const md = 'use `[x](b.md)` here\n\n```md\n[x](b.md)\n```\n';
  assert.equal(rewriteLinks(md, ctx), md);
});

test('a code span inside link text survives the rewrite', () => {
  assert.equal(rewriteLinks('[`b`](b.md)', ctx), '[`b`](../b-page/)');
});

test('broken and out-of-repo links throw with the source and target', () => {
  assert.throws(() => rewriteLinks('[x](missing.md)', ctx), /docs\/missing\.md/);
  assert.throws(() => rewriteLinks('[x](../../etc/passwd)', ctx), /leaves the repository/);
});

test('heading helpers', () => {
  assert.equal(firstHeading('\n# Install `with` npx\n\ntext'), 'Install with npx');
  assert.equal(stripH1('# Title\n\nBody'), 'Body');
  assert.equal(stripH1('Body only'), 'Body only');
});

test('frontmatter quotes titles that contain YAML syntax', () => {
  const out = withFrontmatter({ title: 'A: "b"', description: 'x' }, 'body');
  assert.match(out, /^---\ntitle: "A: \\"b\\""\ndescription: "x"\n---\n\nbody\n$/);
});

test('mapProse skips fenced code of either marker', () => {
  const md = 'A\n~~~\nA\n~~~\n```\nA\n```\nA';
  assert.equal(mapProse(md, (s) => s.replaceAll('A', 'B')), 'B\n~~~\nA\n~~~\n```\nA\n```\nB');
});
