import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MERMAID_FENCE = /```mermaid\n([\s\S]*?)```/g;
const DIAGRAM_TYPES = { flowchart: 'Flowchart', graph: 'Flowchart', sequenceDiagram: 'Sequence diagram', stateDiagram: 'State diagram', 'stateDiagram-v2': 'State diagram', classDiagram: 'Class diagram', erDiagram: 'Entity diagram' };
const NODE_LABEL = /\b[A-Za-z0-9_]+(?:\[\(|\(\(|\[\[|\[|\(|\{)"?([^"\]\)\}]+?)"?(?:\)\]|\)\)|\]\]|\]|\)|\})/g;
const PARTICIPANT = /^\s*(?:participant|actor)\s+\S+(?:\s+as\s+(.+))?$/gm;
const MAX_ALT_LABELS = 8;

/**
 * Alt text for a mermaid diagram: its type and the first node or participant labels, each cut at its
 * first line break, e.g. "Sequence diagram: Agent, Context store, Model API".
 * @param {string} diagram
 */
export function mermaidAlt(diagram) {
  const first = diagram.trim().split(/\s/)[0];
  const type = DIAGRAM_TYPES[first] ?? 'Diagram';
  const clean = (t) => t.split(/<br\s*\/?>/)[0].replace(/<\/?(?:b|i|u|em|strong|small|code|sub|sup|span)\b[^>]*>/gi, '').replace(/"/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').trim();
  const raw = first === 'sequenceDiagram'
    ? [...diagram.matchAll(PARTICIPANT)].map((m) => m[1] ?? m[0].trim().split(/\s+/)[1])
    : [...diagram.matchAll(NODE_LABEL)].map((m) => m[1]);
  const labels = [...new Set(raw.map(clean).filter(Boolean))];
  if (!labels.length) return type;
  const shown = labels.slice(0, MAX_ALT_LABELS).join(', ');
  return `${type}: ${shown}${labels.length > MAX_ALT_LABELS ? ', …' : ''}`;
}

/** @param {string} md */
export function mermaidBlockCount(md) {
  return [...md.matchAll(MERMAID_FENCE)].length;
}

/**
 * Replace ```mermaid fences with links to committed SVGs under public/diagrams/.
 * @param {string} md
 * @param {{ outDir: string, urlPrefix: string, namePrefix: string }} opts
 */
export function embedMermaidAsImages(md, opts) {
  const { outDir, urlPrefix, namePrefix } = opts;
  let index = 0;
  return md.replace(MERMAID_FENCE, (_m, diagram) => {
    index += 1;
    const file = `${namePrefix}-${index}.svg`;
    const outPath = join(outDir, file);
    if (!existsSync(outPath)) {
      throw new Error(
        `missing diagram SVG ${outPath}. After editing mermaid in the doc source, run: cd site && pnpm render-diagrams`,
      );
    }
    const alt = mermaidAlt(diagram);
    const darkFile = `${namePrefix}-${index}-dark.svg`;
    if (existsSync(join(outDir, darkFile))) {
      return `\n<div class="pm-diagram-duo">\n<img class="pm-diagram-light" src="${urlPrefix}${file}" alt="${alt}" />\n<img class="pm-diagram-dark" src="${urlPrefix}${darkFile}" alt="${alt}" />\n</div>\n`;
    }
    return `\n![${alt}](${urlPrefix}${file})\n`;
  });
}

/**
 * Render one mermaid diagram to SVG (maintainer script only — uses npx + Puppeteer).
 * @param {string} diagram
 * @param {string} outPath
 */
export function renderMermaidToSvg(diagram, outPath, { theme, background } = {}) {
  const siteRoot = fileURLToPath(new URL('../..', import.meta.url));
  const puppeteerConfig = join(siteRoot, 'scripts', 'mermaid-puppeteer.json');
  mkdirSync(join(outPath, '..'), { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'pm-mmdc-'));
  const input = join(work, 'diagram.mmd');
  writeFileSync(input, diagram, 'utf8');
  const bg = background ?? (theme === 'dark' ? '#1a1b26' : '#f9f9fb');
  const args = ['--yes', '@mermaid-js/mermaid-cli', '-i', input, '-o', outPath, '-b', bg, '-p', puppeteerConfig];
  if (theme) args.splice(args.length - 2, 0, '-t', theme);
  try {
    execFileSync('npx', args, { stdio: 'inherit', cwd: siteRoot });
    if (!readFileSync(outPath, 'utf8').includes('<svg')) {
      throw new Error(`mmdc did not produce SVG at ${outPath}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * @deprecated Use embedMermaidAsImages at build time; run pnpm render-diagrams to refresh SVGs.
 */
export function replaceMermaidWithImages(md, opts) {
  const { outDir, urlPrefix, namePrefix } = opts;
  mkdirSync(outDir, { recursive: true });
  let index = 0;
  return md.replace(MERMAID_FENCE, (_, diagram) => {
    index += 1;
    const file = `${namePrefix}-${index}.svg`;
    renderMermaidToSvg(diagram.trim(), join(outDir, file));
    const alt = index === 1 ? 'Architecture diagram' : `Architecture diagram ${index}`;
    return `\n![${alt}](${urlPrefix}${file})\n`;
  });
}
