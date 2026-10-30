#!/usr/bin/env node
// Render the ContextBench charts (light and dark SVG, public/charts/) and the generated
// benchmark block of docs/context-management.md from src/data/contextbench.json.
// Every value is read from that file; run compute-contextbench.py first.
//   node scripts/bench/render-contextbench.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = join(SITE, 'src', 'data', 'contextbench.json');
const OUT = join(SITE, 'public', 'charts');
const DOC = join(SITE, '..', 'docs', 'context-management.md');
const CHART_URL = 'https://bcmyguest.github.io/openmem/charts/';

const THEMES = {
  light: { bg: '#ffffff', ink: '#1b1d2a', muted: '#555b72', grid: '#e1e3ee', series: { smart: '#2a78d6', s2: '#eb6834', s1: '#1baf7a' } },
  dark: { bg: '#171a25', ink: '#eceef7', muted: '#b4b9d0', grid: '#343a54', series: { smart: '#3987e5', s2: '#d95926', s1: '#199e70' } },
};
const ORDER = ['smart', 's2', 's1'];
const SHORT = { smart: 'Smart compaction', s2: 'Native compaction', s1: 'Keep everything' };
const FONT = "font-family=\"system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif\"";
const W = 560;
const PAD = { l: 64, r: 20, t: 34, b: 34 };
const PANEL_H = 190;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function marker(key, x, y, color, bg) {
  const ring = `stroke="${bg}" stroke-width="2"`;
  if (key === 's2') return `<rect x="${x - 5.5}" y="${y - 5.5}" width="11" height="11" fill="${color}" ${ring}/>`;
  if (key === 's1') return `<path d="M${x} ${y - 7} L${x + 6.5} ${y + 5} L${x - 6.5} ${y + 5} Z" fill="${color}" ${ring}/>`;
  return `<circle cx="${x}" cy="${y}" r="6" fill="${color}" ${ring}/>`;
}

function legend(settings, t, y) {
  let x = 16;
  return ORDER.map((k) => {
    const label = SHORT[k];
    const g = `${marker(k, x + 6, y - 5, t.series[k], t.bg)}<text x="${x + 18}" y="${y}" font-size="14" fill="${t.ink}">${esc(label)}</text>`;
    x += 34 + label.length * 8;
    return g;
  }).join('');
}

/** One line panel: x = sizes, one line per setting; null values leave a gap. */
function linePanel({ y0, title, xs, series, max, ticks, fmt, t }) {
  const iw = W - PAD.l - PAD.r;
  const ih = PANEL_H - PAD.t - PAD.b;
  const top = y0 + PAD.t;
  const px = (i) => PAD.l + (iw * (i + 0.5)) / xs.length;
  const py = (v) => top + ih - (v / max) * ih;
  const out = [`<text x="${PAD.l}" y="${y0 + 20}" font-size="15" font-weight="600" fill="${t.ink}">${esc(title)}</text>`];
  for (const v of ticks) {
    out.push(`<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${py(v)}" y2="${py(v)}" stroke="${t.grid}" stroke-width="1"/>`);
    out.push(`<text x="${PAD.l - 8}" y="${py(v) + 4}" font-size="13" text-anchor="end" fill="${t.muted}">${fmt(v)}</text>`);
  }
  xs.forEach((x, i) => out.push(`<text x="${px(i)}" y="${top + ih + 22}" font-size="13" text-anchor="middle" fill="${t.muted}">${esc(x)}</text>`));
  for (const k of [...ORDER].reverse()) {
    const vals = series[k];
    let seg = [];
    const segs = [];
    vals.forEach((v, i) => {
      if (v == null) {
        if (seg.length) segs.push(seg);
        seg = [];
      } else seg.push([px(i), py(Math.min(v, max))]);
    });
    if (seg.length) segs.push(seg);
    for (const s of segs) {
      if (s.length > 1) out.push(`<polyline points="${s.map((p) => p.join(',')).join(' ')}" fill="none" stroke="${t.series[k]}" stroke-width="2"/>`);
    }
    for (const s of segs) for (const [x, y] of s) out.push(marker(k, x, y, t.series[k], t.bg));
  }
  return out.join('');
}

function svg(h, body, t, title, desc) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${h}" width="${W}" height="${h}" role="img" ${FONT}><title>${esc(title)}</title><desc>${esc(desc)}</desc><rect width="${W}" height="${h}" fill="${t.bg}"/>${body}</svg>\n`;
}

function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

function lineChart(data, t, panels, title, desc) {
  const sizes = { kv: ['R1000', 'R4000', 'R16000'], log: ['L1600', 'L6400', 'L12800'] };
  let body = legend(data.settings, t, 22);
  panels.forEach((p, i) => {
    const xs = sizes[p.fam];
    const series = Object.fromEntries(ORDER.map((k) => [k, xs.map((s) => p.get(data.cells[k][p.fam][s]))]));
    const all = Object.values(series).flat().filter((v) => v != null);
    const max = p.max ?? niceMax(Math.max(...all));
    const ticks = p.ticks ?? [0, max / 2, max];
    body += linePanel({ y0: 36 + i * PANEL_H, title: p.title, xs, series, max, ticks, fmt: p.fmt, t });
  });
  return svg(40 + panels.length * PANEL_H, body, t, title, desc);
}

function barChart(data, t) {
  const tm = data.timing;
  const rows = [
    ['s2', 'Native summary call', tm.s2.native_summary_request_latency_s],
    ['s2', 'Native, Claude Code timer', tm.s2.native_cc_compaction_s],
    ['smart', 'Smart trimming request', tm.smart.smart_trim_request_latency_s],
    ['smart', 'Smart other requests', tm.smart.smart_other_request_latency_s],
  ];
  const max = niceMax(Math.max(...rows.map((r) => r[2].p90)));
  const lw = 210;
  const iw = W - lw - PAD.r - 30;
  const px = (v) => lw + (v / max) * iw;
  const rowH = 46;
  const top = 54;
  const out = [`<text x="16" y="24" font-size="15" font-weight="600" fill="${t.ink}">Seconds per compaction event (median, bar; p10–p90, whisker)</text>`];
  for (const v of [0, max / 2, max]) {
    out.push(`<line x1="${px(v)}" x2="${px(v)}" y1="${top - 8}" y2="${top + rows.length * rowH}" stroke="${t.grid}"/>`);
    out.push(`<text x="${px(v)}" y="${top + rows.length * rowH + 18}" font-size="13" text-anchor="middle" fill="${t.muted}">${v} s</text>`);
  }
  rows.forEach(([k, label, d], i) => {
    const y = top + i * rowH;
    const c = t.series[k];
    out.push(`<text x="16" y="${y + 19}" font-size="14" fill="${t.ink}">${esc(label)}</text>`);
    out.push(`<text x="16" y="${y + 35}" font-size="12" fill="${t.muted}">n = ${d.n}</text>`);
    out.push(`<rect x="${lw}" y="${y + 6}" width="${Math.max(px(d.median) - lw, 2)}" height="18" rx="4" fill="${c}"/>`);
    out.push(`<line x1="${px(d.p10)}" x2="${px(d.p90)}" y1="${y + 31}" y2="${y + 31}" stroke="${t.ink}" stroke-width="1.5"/>`);
    for (const v of [d.p10, d.p90]) out.push(`<line x1="${px(v)}" x2="${px(v)}" y1="${y + 27}" y2="${y + 35}" stroke="${t.ink}" stroke-width="1.5"/>`);
    out.push(`<text x="${px(d.median) + 6}" y="${y + 20}" font-size="13" fill="${t.ink}">${d.median.toFixed(1)} s</text>`);
  });
  return svg(top + rows.length * rowH + 30, out.join(''), t, 'Compaction time', 'Latency of native compaction summary requests and Claude Code compaction durations against OpenMem trimming requests and other requests.');
}

const num = (v) => v.toFixed(1).replace(/\.0$/, '');
const CHARTS = {
  'contextbench-quality': (d, t) =>
    lineChart(d, t, [
      { fam: 'kv', title: 'kv-store: score', get: (c) => c.score ?? null, max: 1, ticks: [0, 0.5, 1], fmt: (v) => v.toFixed(1) },
      { fam: 'log', title: 'log-triage: score', get: (c) => c.score ?? null, max: 1, ticks: [0, 0.5, 1], fmt: (v) => v.toFixed(1) },
      { fam: 'log', title: 'log-triage: lookup questions', get: (c) => c.lookup ?? null, max: 1, ticks: [0, 0.5, 1], fmt: (v) => v.toFixed(1) },
      { fam: 'log', title: 'log-triage: count questions', get: (c) => c.count ?? null, max: 1, ticks: [0, 0.5, 1], fmt: (v) => v.toFixed(1) },
    ], 'Answer quality by task size', 'Mean tag-insensitive score per task size for keep-everything, native compaction and OpenMem smart compaction.'),
  'contextbench-time': (d, t) =>
    lineChart(d, t, [
      { fam: 'kv', title: 'kv-store: agent wall time per trial (min)', get: (c) => (c.agent_wall_s == null ? null : c.agent_wall_s / 60), fmt: num },
      { fam: 'log', title: 'log-triage: agent wall time per trial (min)', get: (c) => (c.agent_wall_s == null ? null : c.agent_wall_s / 60), fmt: num },
    ], 'Wall time per trial', 'Mean agent wall time per trial, in minutes, by task size and setting.'),
  'contextbench-cost': (d, t) =>
    lineChart(d, t, [
      { fam: 'kv', title: 'kv-store: list-price cost per trial (USD)', get: (c) => c.usd ?? null, fmt: (v) => `$${v.toFixed(2)}` },
      { fam: 'log', title: 'log-triage: list-price cost per trial (USD)', get: (c) => c.usd ?? null, fmt: (v) => `$${v.toFixed(2)}` },
    ], 'Cost per trial', 'Mean list-price cost per trial in US dollars, Claude Haiku 5.5, by task size and setting.'),
  'contextbench-compaction': barChart,
};

const f2 = (v) => (v == null ? '—' : v.toFixed(2));
const kTok = (v) => (v == null ? '—' : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${Math.round(v / 1000)}k`);
const usd = (v) => (v == null ? '—' : `$${v.toFixed(2)}`);
const SIZE_ROWS = [['kv', 'R1000'], ['kv', 'R4000'], ['kv', 'R16000'], ['log', 'L1600'], ['log', 'L6400'], ['log', 'L12800']];
const TASK = { kv: 'kv-store', log: 'log-triage' };

function chartHtml(name, alt) {
  return `<div class="pm-diagram-duo">\n<img class="pm-diagram-light" src="${CHART_URL}${name}.svg" alt="${alt}" />\n<img class="pm-diagram-dark" src="${CHART_URL}${name}-dark.svg" alt="${alt} (dark theme)" />\n</div>`;
}

function scoreCell(c, k) {
  if (!c.n) return 'no completed trial';
  let s = f2(c.score);
  if (c.lookup != null) s += ` (lookup ${f2(c.lookup)}, count ${f2(c.count)})`;
  if (c.tag_dropped_seeds?.length) s += ' †';
  if (c.terminated_by?.includes('max_steps')) s += ' ‡';
  return `${s}, n = ${c.n}`;
}

function dist(d) {
  return `median ${d.median.toFixed(1)} s (p10–p90 ${d.p10.toFixed(1)}–${d.p90.toFixed(1)} s, n = ${d.n})`;
}

/** Markdown between the contextbench markers in docs/context-management.md. */
function benchmarkMarkdown(d) {
  const c = d.cells;
  const L = Object.fromEntries(d.settings.map((s) => [s.key, s.label]));
  const t = d.timing;
  const quality = [
    `| Task, size | ${L.smart} | ${L.s2} | ${L.s1} |`,
    '| --- | --- | --- | --- |',
    ...SIZE_ROWS.map(([f, s]) => `| ${TASK[f]} ${s} | ${['smart', 's2', 's1'].map((k) => scoreCell(c[k][f][s], k)).join(' | ')} |`),
  ];
  const cost = [
    '| Task, size | Peak prompt (smart / native / keep) | Tokens per trial, cache reads in parentheses (smart / native / keep) | List-price cost per trial (smart / native / keep) |',
    '| --- | --- | --- | --- |',
    ...SIZE_ROWS.map(([f, s]) => {
      const cs = ['smart', 's2', 's1'].map((k) => c[k][f][s]);
      return `| ${TASK[f]} ${s} | ${cs.map((x) => kTok(x.peak_prompt_max)).join(' / ')} | ${cs
        .map((x) => (x.n ? `${kTok(x.tokens.total_tokens)} (${kTok(x.tokens.cache_read)})` : '—'))
        .join(' / ')} | ${cs.map((x) => usd(x.usd)).join(' / ')} |`;
    }),
  ];
  const time = [
    '| Setting | Trials | Agent wall time per trial, mean | Requests | Request latency, mean |',
    '| --- | --- | --- | --- | --- |',
    ...['smart', 's2', 's1'].map((k) => `| ${L[k]} | ${t[k].trials} | ${(t[k].agent_wall_s.mean / 60).toFixed(1)} min | ${t[k].requests} | ${t[k].request_latency_s.mean.toFixed(2)} s |`),
  ];
  const nat = t.s2.native_detected_vs_cc;
  return [
    chartHtml('contextbench-quality', 'Answer quality by task size: OpenMem smart compaction, native compaction, keep everything'),
    '',
    `Score is ${d.score_metric}, the mean over the completed seeds of each cell. † a seed dropped the \`#tag\` from its kv answers and scored 0 under the strict reward; the values were right. ‡ the harness step limit stopped the trial before any question, so the 0 is not a recall score.`,
    '',
    ...quality,
    '',
    '### Time',
    '',
    chartHtml('contextbench-compaction', 'Seconds per compaction event: native summary call against the OpenMem trimming request'),
    '',
    `Native compaction is a model call. Claude Code's summary call took ${dist(t.s2.native_summary_request_latency_s)}; Claude Code's own compaction timer read ${dist(t.s2.native_cc_compaction_s)}. The summary calls are the requests after which the next prompt drops below half its size; that finds ${nat.detected} of the ${nat.cc_compact_boundaries} compactions Claude Code reported.`,
    '',
    `Smart compaction makes no model call: the proxy cuts the history in its pre-call hook and records no separate hook time. The request that carried a trim took ${dist(t.smart.smart_trim_request_latency_s)}, against ${dist(t.smart.smart_other_request_latency_s)} for the other requests of the same run. That request also rewrites the prompt cache for the shortened history, so the difference is an upper bound on the trim's own time, assuming LiteLLM's request timer covers the pre-call hook (not verified).`,
    '',
    chartHtml('contextbench-time', 'Agent wall time per trial by task size'),
    '',
    ...time,
    '',
    'Wall time and request latency come from different runs: the baselines (run B) and smart compaction (run D) used different LiteLLM builds, ran at different times under different API load, and only run D had the OpenMem hook. Treat the comparison as rough.',
    '',
    '### Cost and context size',
    '',
    chartHtml('contextbench-cost', 'List-price cost per trial by task size'),
    '',
    'Cost applies Claude Haiku 5.5 list prices to each request’s token counts. Peak prompt is the largest single request.',
    '',
    ...cost,
  ].join('\n');
}

/** Markdown for the Compact-Bench block: nothing but "pending" until the run's task report exists. */
function compactBenchMarkdown(d) {
  const cb = d.compact_bench;
  if (cb.status !== 'complete') {
    return `Results pending. The run is in progress; partial numbers are not published. Methods: ${cb.methods.map((m) => m.label).join(', ')}.`;
  }
  const rows = cb.methods.map((m) =>
    m.key === 'full'
      ? `| ${m.label} | ${m.pass}/${m.n} solved | — | — | — | ${usd(m.cost_usd_mean)} | ${m.continuation_s_mean?.toFixed(0) ?? '—'} s |`
      : `| ${m.label} | ${m.preserved} | ${m.damaged} | ${m.rescued} | ${m.unsolved} | ${usd(m.cost_usd_mean)} | ${m.continuation_s_mean?.toFixed(0) ?? '—'} s |`,
  );
  return [
    '| Method | Preserved | Damaged | Rescued | Unsolved | Cost per run, mean | Continuation time, mean |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

function replaceBlock(md, name, body) {
  const re = new RegExp(`(<!-- ${name}:start[^>]*-->\\n)[\\s\\S]*?(<!-- ${name}:end -->)`);
  if (!re.test(md)) throw new Error(`docs/context-management.md: missing <!-- ${name}:start --> / <!-- ${name}:end --> markers`);
  return md.replace(re, (_m, a, b) => `${a}${body}\n${b}`);
}

const data = JSON.parse(readFileSync(DATA, 'utf8'));
mkdirSync(OUT, { recursive: true });
for (const [name, fn] of Object.entries(CHARTS)) {
  writeFileSync(join(OUT, `${name}.svg`), fn(data, THEMES.light));
  writeFileSync(join(OUT, `${name}-dark.svg`), fn(data, THEMES.dark));
  console.log(`charts: ${name}`);
}

let doc = readFileSync(DOC, 'utf8');
doc = replaceBlock(doc, 'contextbench', benchmarkMarkdown(data));
doc = replaceBlock(doc, 'compact-bench', compactBenchMarkdown(data));
writeFileSync(DOC, doc);
console.log('docs: docs/context-management.md benchmark blocks');
