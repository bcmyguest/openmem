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

test('pictureToDuo: a centered paragraph becomes a figure with a kind class and caption', () => {
  const md = [
    '<p align="center">',
    '<picture>',
    '<source media="(prefers-color-scheme: dark)" srcset="https://h.io/om/media/contextbench-x-dark.png" />',
    '<img src="https://h.io/om/media/contextbench-x.png" alt="Chart" width="480" />',
    '</picture>',
    '<br />',
    '<sub>Score by size.</sub>',
    '</p>',
  ].join('\n');
  const out = pictureToDuo(md, { siteRoot: 'https://h.io/om/', basePath: '/om/' });
  assert.match(out, /^<figure class="pm-figure pm-figure--chart">/);
  assert.match(out, /<img class="pm-diagram-light" src="\/om\/media\/contextbench-x\.png" alt="Chart" \/>/);
  assert.match(out, /<figcaption>Score by size\.<\/figcaption>\n<\/figure>$/);
  assert.doesNotMatch(out, /<p align|<picture>|<sub>|<br/);
});

test('pictureToDuo: two pictures make a pair; a plain image keeps one img', () => {
  const pic = (n) => `<picture>\n<source media="(prefers-color-scheme: dark)" srcset="https://h.io/om/media/${n}-dark.png" />\n<img src="https://h.io/om/media/${n}.png" alt="${n}" width="360" />\n</picture>`;
  const pair = pictureToDuo(`<p align="center">\n${pic('a')}\n${pic('b')}\n</p>`, { siteRoot: 'https://h.io/om/', basePath: '/om/' });
  assert.match(pair, /pm-figure--pair/);
  assert.equal(pair.match(/pm-diagram-duo/g).length, 2);
  const gif = pictureToDuo('<p align="center">\n<img src="https://h.io/om/demo.gif" alt="Demo" width="720" />\n</p>', { siteRoot: 'https://h.io/om/', basePath: '/om/' });
  assert.equal(gif, '<figure class="pm-figure pm-figure--animation">\n<img class="pm-figure-img" src="/om/demo.gif" alt="Demo" />\n</figure>');
  const text = '<p align="center">\nJust text.\n</p>';
  assert.equal(pictureToDuo(text, { siteRoot: 'https://h.io/om/', basePath: '/' }), text);
});
