import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MERMAID_FENCE = /```mermaid\n([\s\S]*?)```/g;

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
  return md.replace(MERMAID_FENCE, () => {
    index += 1;
    const file = `${namePrefix}-${index}.svg`;
    const outPath = join(outDir, file);
    if (!existsSync(outPath)) {
      throw new Error(
        `missing diagram SVG ${outPath}. After editing mermaid in the doc source, run: cd site && pnpm render-diagrams`,
      );
    }
    const alt = index === 1 ? 'Architecture diagram' : `Architecture diagram ${index}`;
    return `\n![${alt}](${urlPrefix}${file})\n`;
  });
}

/**
 * Render one mermaid diagram to SVG (maintainer script only — uses npx + Puppeteer).
 * @param {string} diagram
 * @param {string} outPath
 */
export function renderMermaidToSvg(diagram, outPath) {
  const siteRoot = fileURLToPath(new URL('../..', import.meta.url));
  const puppeteerConfig = join(siteRoot, 'scripts', 'mermaid-puppeteer.json');
  mkdirSync(join(outPath, '..'), { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'pm-mmdc-'));
  const input = join(work, 'diagram.mmd');
  writeFileSync(input, diagram, 'utf8');
  try {
    execFileSync(
      'npx',
      ['--yes', '@mermaid-js/mermaid-cli', '-i', input, '-o', outPath, '-b', '#f9f9fb', '-p', puppeteerConfig],
      { stdio: 'inherit', cwd: siteRoot },
    );
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
