#!/usr/bin/env node
/** Regenerate public/diagrams/*.svg from mermaid in published doc sources. Not part of CI. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGES } from './lib/docs.mjs';
import { mermaidBlockCount, renderMermaidToSvg } from './lib/mermaid-svg.mjs';

const siteRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = join(siteRoot, '..');

const MERMAID_FENCE = /```mermaid\n([\s\S]*?)```/g;

for (const page of PAGES) {
  if (page.kind !== 'doc') continue;
  const source = join(repoRoot, page.source);
  let raw;
  try {
    raw = readFileSync(source, 'utf8');
  } catch {
    if (page.optional) continue;
    throw new Error(`missing doc source: ${page.source}`);
  }
  const count = mermaidBlockCount(raw);
  if (!count) continue;
  const namePrefix = page.slug.replace(/[^a-z0-9-]+/g, '-');
  const outDir = join(siteRoot, 'public', 'diagrams');
  let index = 0;
  for (const match of raw.matchAll(MERMAID_FENCE)) {
    index += 1;
    const outPath = join(outDir, `${namePrefix}-${index}.svg`);
    console.log(`render ${page.source} #${index} -> ${outPath}`);
    renderMermaidToSvg(match[1].trim(), outPath);
    const darkPath = join(outDir, `${namePrefix}-${index}-dark.svg`);
    renderMermaidToSvg(match[1].trim(), darkPath, { theme: 'dark', background: '#1a1b26' });
  }
}
