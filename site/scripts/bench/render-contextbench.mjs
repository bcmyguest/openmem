#!/usr/bin/env node
// Render the ContextBench charts (light and dark SVG, public/charts/) and the generated
// benchmark block of docs/context-management.md from src/data/contextbench.json.
// Every value is read from that file; run compute-contextbench.py first.
//   node scripts/bench/render-contextbench.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { site } from '../../src/site.config.mjs';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = join(SITE, 'src', 'data', 'contextbench.json');
const OUT = join(SITE, 'public', 'charts');
const DOC = join(SITE, '..', 'docs', 'context-management.md');
// site-relative, like the committed mermaid SVGs (sync.mjs); BASE_PATH builds must re-run this script
const CHART_URL = `${site.basePath.replace(/\/?$/, '/')}charts/`;

// Colours: site tokens (src/theme.yml). OpenMem is the brand accent; the baselines are muted greys
// told apart by dash pattern, marker shape and a direct label at the line end.
const THEMES = {
  light: {
    bg: '#ffffff', ink: '#1b1d2a', muted: '#555b72', grid: '#e8e9f1', axis: '#c9ccda',
    series: { smart: '#4651a6', s2: '#6b7088', s1: '#8b90a6' },
  },
  dark: {
    bg: '#171a25', ink: '#eceef7', muted: '#b4b9d0', grid: '#262b3d', axis: '#3d4460',
    series: { smart: '#aab4f6', s2: '#9aa0b8', s1: '#737a96' },
  },
};
const ORDER = ['smart', 's2', 's1'];
const SHORT = { smart: 'OpenMem', s2: 'Native', s1: 'Keep all' };
const DASH = { smart: '', s2: '6 4', s1: '2 4' };
const FONT = "font-family=\"'DM Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif\"";
const W = 480;
const PAD = { l: 52, r: 90, t: 30, b: 30 };
const PANEL_H = 168;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function marker(key, x, y, t) {
  const c = t.series[key];
  const ring = `stroke="${t.bg}" stroke-width="2"`;
  if (key === 's2') return `<rect x="${x - 4.5}" y="${y - 4.5}" width="9" height="9" rx="1.5" fill="${c}" ${ring}/>`;
  if (key === 's1') return `<path d="M${x} ${y - 6} L${x + 5.5} ${y + 4.5} L${x - 5.5} ${y + 4.5} Z" fill="${c}" ${ring}/>`;
  return `<circle cx="${x}" cy="${y}" r="5.5" fill="${c}" ${ring}/>`;
}

/** Wrap text to lines of at most `n` characters. */
function wrap(text, n) {
  const lines = [];
  let cur = '';
  for (const w of text.split(' ')) {
    if (cur && (cur + ' ' + w).length > n) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Chart heading: title plus a computed one-sentence takeaway. Returns [svg, height]. */
function heading(t, title, takeaway) {
  const lines = wrap(takeaway, 56);
  const out = [`<text x="16" y="26" font-size="17" font-weight="700" fill="${t.ink}">${esc(title)}</text>`];
  lines.forEach((l, i) => out.push(`<text x="16" y="${50 + i * 20}" font-size="15" fill="${t.muted}">${esc(l)}</text>`));
  return [out.join(''), lines.length ? 50 + lines.length * 20 : 36];
}

/** One line panel: x = task sizes, one line per setting, direct labels at the right; null leaves a gap. */
function linePanel({ y0, title, xs, series, max, ticks, fmt, t }) {
  const iw = W - PAD.l - PAD.r;
  const ih = PANEL_H - PAD.t - PAD.b;
  const top = y0 + PAD.t;
  const px = (i) => PAD.l + (iw * (i + 0.5)) / xs.length;
  const py = (v) => top + ih - (Math.min(v, max) / max) * ih;
  const out = [`<text x="16" y="${y0 + 18}" font-size="15" font-weight="700" fill="${t.ink}">${esc(title)}</text>`];
  for (const v of ticks) {
    out.push(`<line x1="${PAD.l}" x2="${W - PAD.r + 8}" y1="${py(v)}" y2="${py(v)}" stroke="${v === 0 ? t.axis : t.grid}" stroke-width="1"/>`);
    out.push(`<text x="${PAD.l - 8}" y="${py(v) + 4}" font-size="13" text-anchor="end" fill="${t.muted}">${fmt(v)}</text>`);
  }
  xs.forEach((x, i) => out.push(`<text x="${px(i)}" y="${top + ih + 20}" font-size="13" text-anchor="middle" fill="${t.muted}">${esc(x)}</text>`));
  const ends = [];
  for (const k of [...ORDER].reverse()) {
    const pts = series[k].map((v, i) => (v == null ? null : [px(i), py(v)]));
    let seg = [];
    const segs = [];
    for (const p of pts) {
      if (!p) {
        if (seg.length) segs.push(seg);
        seg = [];
      } else seg.push(p);
    }
    if (seg.length) segs.push(seg);
    for (const s of segs) {
      if (s.length > 1) out.push(`<polyline points="${s.map((p) => p.join(',')).join(' ')}" fill="none" stroke="${t.series[k]}" stroke-width="${k === 'smart' ? 2.75 : 1.75}" ${DASH[k] ? `stroke-dasharray="${DASH[k]}"` : ''} stroke-linecap="round" stroke-linejoin="round"/>`);
    }
    for (const s of segs) for (const [x, y] of s) out.push(marker(k, x, y, t));
    const last = [...pts].reverse().find(Boolean);
    if (last) ends.push({ k, x: last[0], y: last[1], last: pts[pts.length - 1] != null });
  }
  // direct labels in the right margin, nudged apart (min 15 px) so they never overlap
  const lab = ends.filter((e) => e.last).sort((a, b) => a.y - b.y);
  for (let i = 1; i < lab.length; i++) lab[i].ly = Math.max(lab[i].y, (lab[i - 1].ly ?? lab[i - 1].y) + 15);
  if (lab.length) lab[0].ly = lab[0].ly ?? lab[0].y;
  const overflow = (lab.at(-1)?.ly ?? 0) - (top + ih + 4);
  for (const e of lab) {
    const ly = (e.ly ?? e.y) - Math.max(overflow, 0);
    out.push(`<text x="${W - PAD.r + 14}" y="${ly + 4}" font-size="13.5" font-weight="${e.k === 'smart' ? 700 : 500}" fill="${e.k === 'smart' ? t.series.smart : t.muted}">${SHORT[e.k]}</text>`);
  }
  // a setting with no value at the largest size: label its last point instead
  for (const e of ends.filter((x) => !x.last)) {
    out.push(`<text x="${e.x + 9}" y="${e.y - 7}" font-size="12.5" fill="${t.muted}" stroke="${t.bg}" stroke-width="3" paint-order="stroke">${SHORT[e.k]}</text>`);
  }
  return out.join('');
}

function svg(h, body, t, title, desc) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${h}" width="${W}" height="${h}" role="img" aria-label="${esc(title)}" ${FONT}><title>${esc(title)}</title><desc>${esc(desc)}</desc><rect width="${W}" height="${h}" rx="12" fill="${t.bg}"/>${body}</svg>\n`;
}

function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

const SIZES = { kv: ['R1000', 'R4000', 'R16000'], log: ['L1600', 'L6400', 'L12800'] };

function lineChart(data, t, { title, takeaway, desc, panels }) {
  const [head, hh] = heading(t, title, takeaway);
  let body = head;
  panels.forEach((p, i) => {
    const xs = SIZES[p.fam];
    const series = Object.fromEntries(ORDER.map((k) => [k, xs.map((s) => p.get(data.cells[k][p.fam][s]))]));
    const all = Object.values(series).flat().filter((v) => v != null);
    const max = p.max ?? niceMax(Math.max(...all));
    const ticks = p.ticks ?? [0, max / 2, max];
    body += linePanel({ y0: hh + 10 + i * PANEL_H, title: p.title, xs, series, max, ticks, fmt: p.fmt, t });
  });
  return svg(hh + 18 + panels.length * PANEL_H, body, t, title, `${takeaway} ${desc}`);
}

function barChart(data, t) {
  const tm = data.timing;
  const nat = tm.s2.native_summary_request_latency_s;
  const trim = tm.smart.smart_trim_request_latency_s;
  const other = tm.smart.smart_other_request_latency_s;
  const rows = [
    ['s2', 'Native: summary call (model only)', nat],
    ['s2', 'Native: Claude Code timer', tm.s2.native_cc_compaction_s],
    ['smart', 'OpenMem: whole request incl. answer (upper bound)', trim],
    ['smart', 'OpenMem: other requests', other],
  ];
  const takeaway = `A native compaction waits on a summary call (median ${nat.median.toFixed(1)}\u00a0s). OpenMem trims without a model call; the whole request that carried a trim, answer included, took ${trim.median.toFixed(1)}\u00a0s, against ${other.median.toFixed(1)}\u00a0s for other requests.`;
  const [head, hh] = heading(t, 'Time per compaction event', takeaway);
  const max = niceMax(Math.max(...rows.map((r) => r[2].p90)));
  const lw = 16;
  const iw = W - 32;
  const px = (v) => lw + (v / max) * iw;
  const rowH = 54;
  const top = hh + 18;
  const out = [head];
  for (const v of [0, max / 2, max]) {
    out.push(`<line x1="${px(v)}" x2="${px(v)}" y1="${top}" y2="${top + rows.length * rowH}" stroke="${v === 0 ? t.axis : t.grid}"/>`);
    out.push(`<text x="${px(v)}" y="${top + rows.length * rowH + 16}" font-size="12" text-anchor="${v === 0 ? 'start' : v === max ? 'end' : 'middle'}" fill="${t.muted}">${v} s</text>`);
  }
  rows.forEach(([k, label, d], i) => {
    const y = top + i * rowH;
    const c = t.series[k];
    out.push(`<text x="${lw}" y="${y + 16}" font-size="13" font-weight="${k === 'smart' ? 700 : 500}" fill="${k === 'smart' ? t.ink : t.muted}">${esc(label)} <tspan font-weight="400" fill="${t.muted}">· n = ${d.n}</tspan></text>`);
    out.push(`<rect x="${lw}" y="${y + 24}" width="${Math.max(px(d.median) - lw, 3)}" height="16" rx="4" fill="${c}"/>`);
    out.push(`<line x1="${px(d.p10)}" x2="${px(d.p90)}" y1="${y + 46}" y2="${y + 46}" stroke="${t.muted}" stroke-width="1.25"/>`);
    for (const v of [d.p10, d.p90]) out.push(`<line x1="${px(v)}" x2="${px(v)}" y1="${y + 43}" y2="${y + 49}" stroke="${t.muted}" stroke-width="1.25"/>`);
    out.push(`<text x="${px(d.median) + 6}" y="${y + 37}" font-size="12.5" font-weight="700" fill="${t.ink}">${d.median.toFixed(1)} s</text>`);
  });
  out.push(`<text x="${lw}" y="${top + rows.length * rowH + 36}" font-size="11.5" fill="${t.muted}">Bar: median. Whisker: 10th to 90th percentile.</text>`);
  out.push(`<text x="${lw}" y="${top + rows.length * rowH + 52}" font-size="11.5" fill="${t.muted}">Native (run B) and OpenMem (run D) ran on different LiteLLM builds</text>`);
  out.push(`<text x="${lw}" y="${top + rows.length * rowH + 67}" font-size="11.5" fill="${t.muted}">at different times; compare the scale, not small gaps.</text>`);
  return svg(top + rows.length * rowH + 80, out.join(''), t, 'Time per compaction event', takeaway);
}

const num = (v) => v.toFixed(1).replace(/\.0$/, '');
const mins = (c) => (c.agent_wall_s == null ? null : c.agent_wall_s / 60);
const big = (d, fam) => SIZES[fam].at(-1);
const sc = (v) => (v == null ? 'no trial' : v.toFixed(2));

function qualityTakeaway(d) {
  const part = (fam, task) => {
    const h = d.headline[fam];
    const kept = (k, name) => (h[k].score == null ? `no ${name} trial` : `${name} ${sc(h[k].score)}`);
    return `${task} ${h.size}: OpenMem ${sc(h.smart.score)}, ${kept('s2', 'native')}, ${kept('s1', 'keep everything')}.`;
  };
  return `Largest sizes. ${part('kv', 'kv-store')} ${part('log', 'log-triage')}`;
}
function timeTakeaway(d) {
  const L = big(d, 'log');
  const c = (k) => mins(d.cells[k].log[L]);
  return `At log-triage ${L} an OpenMem trial took ${num(c('smart'))} min and a keep-everything trial ${num(c('s1'))} min. The runs had different API load, so treat the gap as rough.`;
}
function costTakeaway(d) {
  const L = big(d, 'log');
  const c = (k) => d.cells[k].log[L].usd;
  // largest relative gap between OpenMem and native compaction over the cells where both ran
  const gaps = Object.keys(SIZES).flatMap((f) => SIZES[f].map((s) => [d.cells.smart[f][s].usd, d.cells.s2[f][s].usd]))
    .filter(([a, b]) => a != null && b != null)
    .map(([a, b]) => Math.abs(a - b) / b);
  const pct = Math.ceil(Math.max(...gaps) * 100);
  return `At log-triage ${L} keep everything cost $${c('s1').toFixed(2)} per trial and OpenMem $${c('smart').toFixed(2)}. Where both ran, OpenMem cost within ${pct}% of native compaction.`;
}

const CHARTS = {
  'contextbench-quality': (d, t) =>
    lineChart(d, t, {
      title: 'Answer quality by task size',
      takeaway: qualityTakeaway(d),
      desc: 'Mean tag-insensitive score per task size; log-triage split into lookup and count questions.',
      panels: [
        { fam: 'kv', title: 'kv-store score', get: (c) => c.score ?? null, max: 1, ticks: [0, 0.5, 1], fmt: (v) => v.toFixed(1) },
        { fam: 'log', title: 'log-triage score', get: (c) => c.score ?? null, max: 1, ticks: [0, 0.5, 1], fmt: (v) => v.toFixed(1) },
        { fam: 'log', title: 'log-triage lookup questions', get: (c) => c.lookup ?? null, max: 1, ticks: [0, 0.5, 1], fmt: (v) => v.toFixed(1) },
        { fam: 'log', title: 'log-triage count questions', get: (c) => c.count ?? null, max: 1, ticks: [0, 0.5, 1], fmt: (v) => v.toFixed(1) },
      ],
    }),
  'contextbench-quality-compact': (d, t) =>
    lineChart(d, t, {
      title: 'Score by task size',
      takeaway: '',
      desc: 'Mean tag-insensitive score per task size.',
      panels: [
        { fam: 'kv', title: 'kv-store', get: (c) => c.score ?? null, max: 1, ticks: [0, 0.5, 1], fmt: (v) => v.toFixed(1) },
        { fam: 'log', title: 'log-triage', get: (c) => c.score ?? null, max: 1, ticks: [0, 0.5, 1], fmt: (v) => v.toFixed(1) },
      ],
    }),
  'contextbench-time': (d, t) =>
    lineChart(d, t, {
      title: 'Wall time per trial',
      takeaway: timeTakeaway(d),
      desc: 'Mean agent wall time per trial in minutes; runs differ in API load.',
      panels: [
        { fam: 'kv', title: 'kv-store, minutes', get: mins, fmt: num },
        { fam: 'log', title: 'log-triage, minutes', get: mins, fmt: num },
      ],
    }),
  'contextbench-cost': (d, t) =>
    lineChart(d, t, {
      title: 'Cost per trial',
      takeaway: costTakeaway(d),
      desc: 'Mean list-price cost per trial in US dollars, Claude Haiku 5.5.',
      panels: [
        { fam: 'kv', title: 'kv-store, USD', get: (c) => c.usd ?? null, fmt: (v) => `$${v.toFixed(2)}` },
        { fam: 'log', title: 'log-triage, USD', get: (c) => c.usd ?? null, fmt: (v) => `$${v.toFixed(2)}` },
      ],
    }),
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
