// Walks a built directory and applies the privacy rules to every text file.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { RULES, scanText } from './privacy.mjs';

const KIND = {
  '.html': 'html',
  '.md': 'md',
  '.txt': 'md',
  '.xml': 'text',
  '.js': 'text',
  '.mjs': 'text',
  '.css': 'text',
  '.json': 'text',
  '.svg': 'text',
  '.webmanifest': 'text',
  '': 'text',
};

// Pagefind (Starlight search) bundles translator credit emails. Those files
// skip only the email rule; every other rule still applies to them.
const EMAIL_EXEMPT = /(^|\/)(pagefind\/[^/]+\.js|_astro\/ui-core\.[^/]+\.js)$/;

/** @param {string} dir */
function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (extname(name).toLowerCase() in KIND) yield p;
  }
}

/**
 * @param {string} dir
 * @param {{ deny?: string[] }} [opts]
 * @returns {{ files: number, findings: ReturnType<typeof scanText> }}
 */
export function scanDir(dir, { deny = [] } = {}) {
  const findings = [];
  let files = 0;
  for (const path of walk(dir)) {
    files++;
    const rel = relative(dir, path).split('\\').join('/');
    const rules = EMAIL_EXEMPT.test(rel) ? RULES.filter((r) => r.id !== 'email') : RULES;
    const kind = KIND[extname(path).toLowerCase()];
    findings.push(...scanText(readFileSync(path, 'utf8'), { kind, file: `dist/${rel}`, deny, rules }));
  }
  return { files, findings };
}
