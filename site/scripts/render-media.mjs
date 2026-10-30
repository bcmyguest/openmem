#!/usr/bin/env node
// Export the site's charts and overview diagrams as 2x PNGs, and the smart-compaction animation as
// light and dark GIFs, into public/media/ (published at <site>/media/, referenced by README.md and
// docs/*.md so GitHub renders them). Maintainer script, not part of the build.
//
//   pnpm media     # = render-overview + bench:render + build + this script
//
// Needs Chrome or Chromium (CHROME_BIN, else google-chrome / chromium on PATH), driven over the
// DevTools protocol with Node's built-in WebSocket, and `uv` for the GIF encoder (Pillow), as
// scripts/render-setup-gif.py does for the setup demo. The GIF frames come from the built page
// (dist/), with every CSS animation paused and seeked, so the frames are deterministic.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { site } from '../src/site.config.mjs';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUB = join(SITE, 'public');
const OUT = join(PUB, 'media');
const DIST = join(SITE, 'dist');
const FONT_DIR = join(SITE, 'node_modules', '@fontsource', 'dm-sans', 'files');
const SVG_SOURCES = [
  ...readdirSync(join(PUB, 'charts')).filter((f) => f.endsWith('.svg')).map((f) => join(PUB, 'charts', f)),
  ...readdirSync(join(PUB, 'diagrams')).filter((f) => f.startsWith('overview-') && f.endsWith('.svg')).map((f) => join(PUB, 'diagrams', f)),
];
const GIF_SECONDS = 14; // SmartCompactionFigure's loop length
const GIF_FPS = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chromeBin() {
  for (const c of [process.env.CHROME_BIN, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    if (!c) continue;
    try {
      execFileSync('which', [c], { stdio: 'ignore' });
      return c;
    } catch {}
  }
  throw new Error('render-media: no Chrome found; set CHROME_BIN');
}

/** Launch headless Chrome and return a tiny CDP client for its first page. */
async function launch() {
  const profile = mkdtempSync(join(tmpdir(), 'om-media-'));
  const proc = spawn(chromeBin(), ['--headless=new', '--no-sandbox', '--hide-scrollbars', '--remote-debugging-port=0', '--remote-allow-origins=*', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  if (!existsSync(portFile)) throw new Error('render-media: Chrome did not start');
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
      const timer = setTimeout(() => reject(new Error(`render-media: ${method} timed out`)), 60000);
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
  await Promise.race([loaded, sleep(15000).then(() => { throw new Error(`render-media: ${url} did not load`); })]);
  await cdp.send('Runtime.evaluate', { expression: 'document.fonts.ready.then(() => true)', awaitPromise: true });
}

async function shot(cdp, clip, scale) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale }, captureBeyondViewport: true });
  return Buffer.from(data, 'base64');
}

/** Each SVG in an HTML page with DM Sans loaded, screenshotted at 2x. */
async function exportPngs(cdp, work) {
  const font = (w) => `@font-face{font-family:'DM Sans';font-weight:${w};src:url('file://${join(FONT_DIR, `dm-sans-latin-${w}-normal.woff2`)}') format('woff2')}`;
  for (const src of SVG_SOURCES) {
    const svg = readFileSync(src, 'utf8');
    const html = `<!doctype html><meta charset="utf-8"><style>${[400, 500, 600, 700].map(font).join('')}html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`;
    const page = join(work, 'page.html');
    writeFileSync(page, html);
    // a roomy viewport first, so `max-width: 100%` on the SVG never shrinks it below its own width
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 2400, height: 3000, deviceScaleFactor: 1, mobile: false });
    await goto(cdp, `file://${page}`);
    const { result } = await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify(document.querySelector("svg").getBoundingClientRect())', returnByValue: true });
    const r = JSON.parse(result.value);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: Math.ceil(r.width), height: Math.ceil(r.height), deviceScaleFactor: 1, mobile: false });
    await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    const name = src.split('/').pop().replace(/\.svg$/, '.png');
    writeFileSync(join(OUT, name), await shot(cdp, { x: 0, y: 0, width: r.width, height: r.height }, 2));
    console.log(`media: ${name}`);
  }
}

/** Serve dist/ under the site's base path. */
function serve() {
  const base = site.basePath.replace(/\/?$/, '/');
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.gif': 'image/gif' };
  const server = createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (!p.startsWith(base)) return res.writeHead(404).end();
    p = join(DIST, p.slice(base.length));
    if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
    if (!existsSync(p)) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' }).end(readFileSync(p));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, url: `http://127.0.0.1:${server.address().port}${base}` })));
}

async function exportGifs(cdp, work) {
  if (!existsSync(join(DIST, 'index.html'))) throw new Error('render-media: dist/ is missing; run pnpm build first');
  const { server, url } = await serve();
  try {
    for (const theme of ['light', 'dark']) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 760, height: 1200, deviceScaleFactor: 1, mobile: false });
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
      await goto(cdp, url);
      const rect = await cdp.send('Runtime.evaluate', {
        returnByValue: true,
        expression: `(() => { document.documentElement.setAttribute('data-theme', '${theme}');
          document.querySelector('header')?.remove();
          const f = document.querySelector('figure.sc .sc-surface'); f.scrollIntoView();
          const r = f.getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; })()`,
      });
      const clip = rect.result.value;
      const frames = join(work, `frames-${theme}`);
      mkdirSync(frames, { recursive: true });
      const n = GIF_SECONDS * GIF_FPS;
      for (let i = 0; i < n; i++) {
        const t = (i * 1000) / GIF_FPS;
        await cdp.send('Runtime.evaluate', { expression: `document.getAnimations().forEach((a) => { a.pause(); a.currentTime = ${t}; })` });
        writeFileSync(join(frames, `${String(i).padStart(4, '0')}.png`), await shot(cdp, clip, 1));
      }
      const gif = join(OUT, `smart-compaction${theme === 'dark' ? '-dark' : ''}.gif`);
      const py = `import glob,sys
from PIL import Image
fs=[Image.open(p).convert('RGB') for p in sorted(glob.glob(sys.argv[1]+'/*.png'))]
q=[f.quantize(colors=128, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE) for f in fs]
q[0].save(sys.argv[2], save_all=True, append_images=q[1:], duration=${Math.round(1000 / GIF_FPS)}, loop=0, optimize=True)`;
      execFileSync('uv', ['run', '--quiet', '--with', 'pillow', 'python', '-c', py, frames, gif], { stdio: 'inherit' });
      console.log(`media: ${gif.split('/').pop()} (${n} frames)`);
    }
  } finally {
    server.close();
  }
}

mkdirSync(OUT, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'om-media-work-'));
const cdp = await launch();
try {
  await exportPngs(cdp, work);
  await exportGifs(cdp, work);
} finally {
  cdp.close();
  rmSync(work, { recursive: true, force: true });
}
