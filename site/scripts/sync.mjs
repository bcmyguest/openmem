// Usage: node scripts/sync.mjs
// Reads ../providers/*/manifest.json and ../docs/*.md, writes the generated
// inputs under src/generated/ and src/content/docs/docs/.
import { fileURLToPath } from 'node:url';
import { runSync } from './lib/sync.mjs';
import { site } from '../src/site.config.mjs';

const siteRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = process.env.PM_REPO_ROOT ?? fileURLToPath(new URL('../..', import.meta.url));

try {
  runSync({ repoRoot, siteRoot, repoUrl: site.repoUrl, branch: site.branch, log: (s) => console.log(`sync: ${s}`) });
} catch (e) {
  console.error(`sync: ${/** @type {Error} */ (e).message}`);
  process.exit(1);
}
