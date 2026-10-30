#!/usr/bin/env node
// Write the overview diagrams (src/components/landing/overview-diagrams.mjs) as static SVGs for docs:
// public/diagrams/overview-{memory,context}[-wide][-dark].svg: narrow (docs show them side by side) and
// wide (README, through the PNG exports of render-media.mjs),
// colours from src/theme.yml. The landing page inlines the same diagrams.
//   node scripts/render-overview-diagrams.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { contextDiagram, memoryDiagram, paletteFromTokens } from '../src/components/landing/overview-diagrams.mjs';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(SITE, 'public', 'diagrams');
const tokens = YAML.parse(readFileSync(join(SITE, 'src', 'theme.yml'), 'utf8')).theme.semantic;

mkdirSync(OUT, { recursive: true });
for (const [name, fn] of [['memory', memoryDiagram], ['context', contextDiagram]]) {
  for (const layout of ['narrow', 'wide']) {
    for (const mode of ['light', 'dark']) {
      const file = `overview-${name}${layout === 'wide' ? '-wide' : ''}${mode === 'dark' ? '-dark' : ''}.svg`;
      writeFileSync(join(OUT, file), `${fn(paletteFromTokens(tokens[mode]), layout, `ov-${name}`)}\n`);
      console.log(`diagrams: ${file}`);
    }
  }
}
