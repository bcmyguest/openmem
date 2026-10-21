import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MERMAID_FENCE = /```mermaid\n([\s\S]*?)```/g;

/** @param {string} md */
export function mermaidBlockCount(md) {
  return [...md.matchAll(MERMAID_FENCE)].length;
}

/**
 * Replace ```mermaid fences with static SVG images (built before Astro).
 * @param {string} md
 * @param {{ outDir: string, urlPrefix: string, namePrefix: string, mmdc?: string }} opts
 */
export function replaceMermaidWithImages(md, opts) {
  const { outDir, urlPrefix, namePrefix } = opts;
  mkdirSync(outDir, { recursive: true });
  let index = 0;
  return md.replace(MERMAID_FENCE, (_, diagram) => {
    index += 1;
    const file = `${namePrefix}-${index}.svg`;
    renderMermaidToSvg(diagram.trim(), join(outDir, file), opts.mmdc);
    const alt = index === 1 ? 'Architecture diagram' : `Architecture diagram ${index}`;
    return `\n![${alt}](${urlPrefix}${file})\n`;
  });
}

/**
 * @param {string} diagram
 * @param {string} outPath
 * @param {string} [mmdcBin]
 */
export function renderMermaidToSvg(diagram, outPath, mmdcBin) {
  const siteRoot = fileURLToPath(new URL('../..', import.meta.url));
  const mmdc = mmdcBin ?? join(siteRoot, 'node_modules', '.bin', 'mmdc');
  const puppeteerConfig = join(siteRoot, 'scripts', 'mermaid-puppeteer.json');
  const work = mkdtempSync(join(tmpdir(), 'pm-mmdc-'));
  const input = join(work, 'diagram.mmd');
  writeFileSync(input, diagram, 'utf8');
  try {
    execFileSync(
      mmdc,
      ['-i', input, '-o', outPath, '-b', 'transparent', '-p', puppeteerConfig],
      { stdio: 'pipe' },
    );
    if (!readFileSync(outPath, 'utf8').includes('<svg')) {
      throw new Error(`mmdc did not produce SVG at ${outPath}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
