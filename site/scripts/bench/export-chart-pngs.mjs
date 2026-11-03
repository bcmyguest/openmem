#!/usr/bin/env node
// Rasterize public/charts/*.svg → public/media/*.png via headless Chrome + DM Sans (GitHub-safe pixels).
// resvg can drop text in PNGs that still look fine locally; Chrome matches render-media.mjs.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHARTS = join(SITE, 'public', 'charts');
const OUT = join(SITE, 'public', 'media');
const FONT_DIR = join(SITE, 'node_modules', '@fontsource', 'dm-sans', 'files');
const SCALE = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chromeBin() {
  for (const c of [process.env.CHROME_BIN, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    if (!c) continue;
    try {
      execFileSync('which', [c], { stdio: 'ignore' });
      return c;
    } catch {}
  }
  throw new Error('export-chart-pngs: no Chrome; set CHROME_BIN');
}

async function launch() {
  const profile = mkdtempSync(join(tmpdir(), 'om-chart-png-'));
  const proc = spawn(chromeBin(), ['--headless=new', '--no-sandbox', '--hide-scrollbars', '--remote-debugging-port=0', '--remote-allow-origins=*', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  if (!existsSync(portFile)) throw new Error('export-chart-pngs: Chrome did not start');
  const port = readFileSync(portFile, 'utf8').split('\n')[0];
  let pages = [];
  for (let i = 0; i < 50 && !pages.length; i++) {
    pages = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((t) => t.type === 'page');
    if (!pages.length) await sleep(100);
  }
  const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let id = 0;
  const pending = new Map();
  const waiters = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else if (m.method) {
      for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].method === m.method) waiters.splice(i, 1)[0].resolve(m.params);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => reject(new Error(`export-chart-pngs: ${method} timed out`)), 60000);
      pending.set(n, { resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const once = (method) => new Promise((resolve) => waiters.push({ method, resolve }));
  await send('Page.enable');
  const close = () => {
    ws.close();
    proc.kill();
    rmSync(profile, { recursive: true, force: true });
  };
  return { send, once, close };
}

async function goto(cdp, url) {
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await Promise.race([loaded, sleep(15000).then(() => { throw new Error(`export-chart-pngs: ${url} did not load`); })]);
  await cdp.send('Runtime.evaluate', { expression: 'document.fonts.ready.then(() => true)', awaitPromise: true });
}

async function shot(cdp, clip, scale) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale }, captureBeyondViewport: true });
  return Buffer.from(data, 'base64');
}

/** @param {string} [chartsDir] @param {string} [outDir] */
export async function exportChartSvgsToPng(chartsDir = CHARTS, outDir = OUT) {
  mkdirSync(outDir, { recursive: true });
  const svgs = readdirSync(chartsDir)
    .filter((f) => f.endsWith('.svg'))
    .map((f) => join(chartsDir, f));
  const font = (w) => `@font-face{font-family:'DM Sans';font-weight:${w};src:url('file://${join(FONT_DIR, `dm-sans-latin-${w}-normal.woff2`)}') format('woff2')}`;
  const work = mkdtempSync(join(tmpdir(), 'om-chart-work-'));
  const cdp = await launch();
  try {
    for (const src of svgs) {
      const svg = readFileSync(src, 'utf8');
      const html = `<!doctype html><meta charset="utf-8"><style>${[400, 500, 600, 700].map(font).join('')}html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`;
      const page = join(work, 'page.html');
      writeFileSync(page, html);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 2400, height: 3000, deviceScaleFactor: 1, mobile: false });
      await goto(cdp, `file://${page}`);
      const { result } = await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify(document.querySelector("svg").getBoundingClientRect())', returnByValue: true });
      const r = JSON.parse(result.value);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: Math.ceil(r.width), height: Math.ceil(r.height), deviceScaleFactor: 1, mobile: false });
      await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
      const name = src.split('/').pop().replace(/\.svg$/, '.png');
      writeFileSync(join(outDir, name), await shot(cdp, { x: 0, y: 0, width: r.width, height: r.height }, SCALE));
      console.log(`media: ${name}`);
    }
  } finally {
    cdp.close();
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await exportChartSvgsToPng();
}
