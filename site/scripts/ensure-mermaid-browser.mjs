#!/usr/bin/env node
/** Install Puppeteer browsers for @mermaid-js/mermaid-cli when missing (CI + fresh clones). */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = fileURLToPath(new URL('..', import.meta.url));
const puppeteer = join(siteRoot, 'node_modules', '.bin', 'puppeteer');
const cache = process.env.PUPPETEER_CACHE_DIR || join(homedir(), '.cache', 'puppeteer');

function hasBrowser(name) {
  return existsSync(join(cache, name));
}

if (!hasBrowser('chrome-headless-shell') && !hasBrowser('chrome')) {
  execFileSync(puppeteer, ['browsers', 'install', 'chrome-headless-shell'], { stdio: 'inherit' });
}
