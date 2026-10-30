// The two overview diagrams (A: memory, B: context management) as hand-built SVG strings.
// One source for the landing page (inline, palette = CSS variables so the theme toggle applies)
// and for docs (scripts/render-overview-diagrams.mjs writes light/dark static files).
// Every name in here is checked against the repository:
//   sources       docs/indexing.md, bin/hindsight-project-index (.md/.mdx docs + tree-sitter code outlines)
//   providers     providers/*/manifest.json status "supported"; default hindsight (wizard/lib/parse-args.mjs)
//   MCP tools     cli/mcp/*.mjs tool names
//   proxy         docs/context-proxy.md (Anthropic for Claude Code and OpenCode 1, ChatGPT Codex backend
//                 for Codex), trim_at_tokens default 125,000 (Haiku 95,000, proxy/openmem_context/settings.py); OpenCode 2 trims in its own plugin

/** Palette that follows the site theme (inline SVG on the landing page). */
export const CSS_PALETTE = {
  canvas: 'var(--c-map-canvas)',
  panel: 'var(--c-panel)',
  raised: 'var(--c-panel-raised)',
  ink: 'var(--c-ink)',
  muted: 'var(--c-muted)',
  line: 'var(--c-line)',
  brand: 'var(--c-brand)',
  brandSoft: 'var(--c-brand-soft)',
  source: 'var(--c-source)',
  dot: 'var(--c-map-dot)',
};

/** Palette from theme.yml semantic tokens (static files). */
export function paletteFromTokens(t) {
  return {
    canvas: t['map-canvas'],
    panel: t.panel,
    raised: t['panel-raised'],
    ink: t.ink,
    muted: t.muted,
    line: t.line,
    brand: t.brand,
    brandSoft: t['brand-soft'],
    source: t.source,
    dot: t['map-dot'],
  };
}

const FONT = "'DM Sans', system-ui, -apple-system, 'Segoe UI', sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A card: small-caps heading, optional subheading, then rows (each row one line; `mono` rows use the code font).
 * accent cards (OpenMem parts) get the brand border and a soft brand fill.
 */
function card(p, { x, y, w, h, title, sub, rows = [], accent = false, chips = false }) {
  const out = [
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${accent ? p.brandSoft : p.panel}" stroke="${accent ? p.brand : p.line}" stroke-width="${accent ? 1.5 : 1}"/>`,
    `<text x="${x + 16}" y="${y + 26}" font-size="11.5" font-weight="700" letter-spacing="1.1" fill="${accent ? p.source : p.muted}">${esc(title.toUpperCase())}</text>`,
  ];
  let cy = y + 26;
  if (sub) {
    cy += 20;
    out.push(`<text x="${x + 16}" y="${cy}" font-size="13" font-style="italic" fill="${p.muted}">${esc(sub)}</text>`);
  }
  cy += 10;
  for (const r of rows) {
    const row = typeof r === 'string' ? { t: r } : r;
    if (chips) {
      cy += 6;
      out.push(`<rect x="${x + 12}" y="${cy}" width="${w - 24}" height="26" rx="7" fill="${accent ? p.panel : p.raised}" stroke="${p.line}"/>`);
      out.push(`<text x="${x + 22}" y="${cy + 17.5}" font-size="${row.mono ? 12.5 : 13.5}" font-weight="${row.strong ? 700 : 600}" ${row.mono ? `font-family="${MONO}"` : ''} fill="${row.dim ? p.muted : p.ink}">${esc(row.t)}</text>`);
      cy += 26;
    } else {
      cy += 21;
      out.push(`<text x="${x + 16}" y="${cy}" font-size="${row.mono ? 12.5 : 14}" font-weight="${row.strong ? 700 : 500}" ${row.mono ? `font-family="${MONO}"` : ''} fill="${row.dim ? p.muted : p.ink}">${esc(row.t)}</text>`);
    }
  }
  return out.join('');
}

/** Arrow along a polyline; `label` is drawn at (lx, ly) with a panel-coloured halo so it stays legible. */
function arrow(p, pts, { label, lx, ly, anchor = 'middle', both = false, dashed = false, color } = {}) {
  const c = color ?? p.brand;
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ');
  const head = (a, b) => {
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const s = 8;
    const l = [b[0] - s * Math.cos(ang - 0.45), b[1] - s * Math.sin(ang - 0.45)];
    const r = [b[0] - s * Math.cos(ang + 0.45), b[1] - s * Math.sin(ang + 0.45)];
    return `<path d="M${b[0]} ${b[1]} L${l[0]} ${l[1]} L${r[0]} ${r[1]} Z" fill="${c}"/>`;
  };
  const out = [`<path d="${d}" fill="none" stroke="${c}" stroke-width="1.75" ${dashed ? 'stroke-dasharray="5 4"' : ''} stroke-linejoin="round"/>`];
  out.push(head(pts[pts.length - 2], pts[pts.length - 1]));
  if (both) out.push(head(pts[1], pts[0]));
  if (label) {
    const lines = Array.isArray(label) ? label : [label];
    lines.forEach((t, i) => {
      out.push(`<text x="${lx}" y="${ly + i * 15}" text-anchor="${anchor}" font-size="12" font-weight="600" fill="${p.muted}" stroke="${p.canvas}" stroke-width="4" paint-order="stroke" stroke-linejoin="round">${esc(t)}</text>`);
    });
  }
  return out.join('');
}

function frame(p, w, h, id, title, desc, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-labelledby="${id}-t ${id}-d" font-family="${FONT}" style="max-width:100%;height:auto"><title id="${id}-t">${esc(title)}</title><desc id="${id}-d">${esc(desc)}</desc><rect width="${w}" height="${h}" rx="14" fill="${p.canvas}"/>${body}</svg>`;
}

const SRC_ROWS = ['Git repos', { t: 'docs, code outlines', dim: true }, 'Obsidian vaults', 'Notes · papers', 'Bookmarks', 'RSS · OpenAlex feeds'];
const IDX_ROWS = ['Polls repos', 'Watches folders', 'Re-indexes on change', { t: 'One sink per provider', dim: true }];
const PROV_ROWS = [{ t: 'Hindsight (default)', strong: true }, 'mem0', 'Cognee', { t: '…', dim: true }];
const MCP_ROWS = [{ t: 'memory_recall', mono: true }, { t: 'memory_add', mono: true }, { t: 'memory_search', mono: true }, { t: 'memory_reflect', mono: true }, { t: 'memory_pages_*', mono: true }, { t: '+ export/import', dim: true }, { t: '+ status, forget…', dim: true }];
const AGENT_ROWS = ['Claude Code', 'Codex', 'Cursor', 'OpenCode'];
const MEMORY_DESC =
  'Sources (Git repos with Markdown docs and code outlines, Obsidian vaults, notes, papers, bookmarks, RSS and OpenAlex feeds) flow into the OpenMem indexer, which writes to one active, swappable memory provider: Hindsight by default, mem0 or Cognee. The OpenMem MCP exposes memory_recall, memory_add, memory_search, memory_reflect, memory_pages tools and more to coding agents (Claude Code, Codex, Cursor, OpenCode); session hooks recall at session start and retain at stop.';

/** Diagram A: memory. layout 'wide' (desktop) or 'narrow' (phone). */
export function memoryDiagram(p, layout = 'wide', id = 'ovm') {
  if (layout === 'wide') {
    const W = 1080, H = 372, Y = 54, CH = 200, CW = 176, G = 38, X0 = 24; // 2·X0 + 5·CW + 4·G = W
    const xs = [0, 1, 2, 3, 4].map((i) => X0 + i * (CW + G));
    const body = [
      `<text x="${X0}" y="32" font-size="15" font-weight="700" fill="${p.ink}">A · Memory</text>`,
      `<text x="${X0 + 104}" y="32" font-size="13" fill="${p.muted}">your sources become memory any agent can query</text>`,
      card(p, { x: xs[0], y: Y, w: CW, h: CH, title: 'Sources', rows: SRC_ROWS }),
      card(p, { x: xs[1], y: Y, w: CW, h: CH, title: 'OpenMem indexer', rows: IDX_ROWS, accent: true }),
      card(p, { x: xs[2], y: Y, w: CW, h: CH, title: 'Memory provider', sub: 'one active, swappable', rows: PROV_ROWS, chips: true }),
      card(p, { x: xs[3], y: Y, w: CW, h: CH + 30, title: 'OpenMem MCP', rows: MCP_ROWS, accent: true }),
      card(p, { x: xs[4], y: Y, w: CW, h: CH, title: 'Coding agents', rows: AGENT_ROWS, chips: true }),
      arrow(p, [[xs[0] + CW + 4, Y + 90], [xs[1] - 4, Y + 90]], { label: 'index', lx: xs[1] - G / 2, ly: Y + 80 }),
      arrow(p, [[xs[1] + CW + 4, Y + 90], [xs[2] - 4, Y + 90]], { label: 'retain', lx: xs[2] - G / 2, ly: Y + 80 }),
      arrow(p, [[xs[2] + CW + 4, Y + 90], [xs[3] - 4, Y + 90]], { both: true }),
      arrow(p, [[xs[3] + CW + 4, Y + 70], [xs[4] - 4, Y + 70]], { both: true, label: 'tools', lx: xs[4] - G / 2, ly: Y + 60 }),
      // session hooks: agents -> MCP, below the cards
      arrow(p, [[xs[4] + CW / 2, Y + CH + 4], [xs[4] + CW / 2, Y + CH + 52], [xs[3] + CW / 2 + 30, Y + CH + 52], [xs[3] + CW / 2 + 30, Y + CH + 34]], { dashed: true }),
      `<text x="${xs[4] + CW / 2 - 20}" y="${Y + CH + 72}" text-anchor="middle" font-size="12.5" font-weight="700" fill="${p.source}">session hooks</text>`,
      `<text x="${xs[4] + CW / 2 - 20}" y="${Y + CH + 88}" text-anchor="middle" font-size="12" fill="${p.muted}">recall at start · retain at stop</text>`,
    ].join('');
    return frame(p, W, H, id, 'OpenMem memory architecture', MEMORY_DESC, body);
  }
  // narrow: one column, cards full width, arrows between
  const W = 360, X = 16, CW = 328;
  let y = 48;
  const parts = [
    `<text x="${X}" y="28" font-size="15" font-weight="700" fill="${p.ink}">A · Memory</text>`,
  ];
  const step = (h, c, label) => {
    parts.push(card(p, { x: X, y, w: CW, h, ...c }));
    y += h;
    if (label !== undefined) {
      parts.push(arrow(p, [[W / 2, y + 4], [W / 2, y + 30]], label ? { label, lx: W / 2 + 12, ly: y + 21, anchor: 'start' } : { both: label === null }));
      y += 34;
    }
  };
  step(109, { title: 'Sources', rows: ['Git repos: Markdown docs, code outlines', 'Obsidian vaults · notes · papers · bookmarks', 'RSS · OpenAlex feeds'] }, 'index');
  step(67, { title: 'OpenMem indexer', rows: ['Polls repos, watches folders, re-indexes'], accent: true }, 'retain');
  step(88, { title: 'Memory provider', sub: 'one active, swappable', rows: ['Hindsight (default) · mem0 · Cognee · …'] }, null);
  step(130, { title: 'OpenMem MCP', rows: [{ t: 'memory_recall · memory_add', mono: true }, { t: 'memory_search · memory_reflect', mono: true }, { t: 'memory_pages_*', mono: true }, { t: '+ export/import, status…', dim: true }], accent: true }, null);
  parts.push(`<text x="${W / 2 + 12}" y="${y - 14}" font-size="12" font-weight="600" fill="${p.muted}">tools · session hooks</text>`);
  step(88, { title: 'Coding agents', rows: ['Claude Code · Codex · Cursor · OpenCode', { t: 'hooks: recall at start, retain at stop', dim: true }] });
  y += 16;
  return frame(p, W, y, id, 'OpenMem memory architecture', MEMORY_DESC, parts.join(''));
}

const CONTEXT_DESC =
  'Coding agents (Claude Code, Codex, OpenCode 1) send requests through the OpenMem context proxy, a LiteLLM hook that trims at 125k tokens (95k for Haiku) without an LLM call and forwards to the model API (Anthropic, or ChatGPT for Codex). The proxy writes every turn verbatim to a SQLite session store, which the agent reads back with the smart_compact_search and smart_compact_sql MCP tools. OpenCode 2 trims in a native plugin with no proxy and writes the same store. Native compaction replaces history with an LLM summary, where exact values can be lost; OpenMem keeps every turn verbatim and searchable.';

function contrast(p, x, y, w) {
  const row = (yy, ok, head, text) =>
    `<rect x="${x}" y="${yy}" width="${w}" height="52" rx="10" fill="${ok ? p.brandSoft : p.panel}" stroke="${ok ? p.brand : p.line}"/>` +
    `<text x="${x + 16}" y="${yy + 21}" font-size="12.5" font-weight="700" fill="${ok ? p.source : p.muted}">${esc(head)}</text>` +
    `<text x="${x + 16}" y="${yy + 40}" font-size="13.5" font-weight="500" fill="${p.ink}">${esc(text)}</text>`;
  return row(y, false, 'Native compaction', 'LLM summary: exact values can be lost') + row(y + 62, true, 'OpenMem', 'every turn kept verbatim and searchable');
}

/** Diagram B: context management. */
export function contextDiagram(p, layout = 'wide', id = 'ovc') {
  if (layout === 'wide') {
    const W = 1080, H = 360;
    const A = { x: 24, y: 54, w: 236, h: 132 };
    const P = { x: 340, y: 54, w: 300, h: 132 };
    const M = { x: 720, y: 54, w: 336, h: 132 };
    const S = { x: 340, y: 236, w: 300, h: 104 };
    const O = { x: 24, y: 236, w: 236, h: 104 };
    const body = [
      `<text x="24" y="32" font-size="15" font-weight="700" fill="${p.ink}">B · Context management</text>`,
      `<text x="232" y="32" font-size="13" fill="${p.muted}">long sessions stay under the limit; nothing is summarized away</text>`,
      card(p, { ...A, title: 'Coding agent', rows: ['Claude Code', 'Codex', 'OpenCode 1'], chips: true }),
      card(p, { ...P, title: 'Context proxy', sub: 'LiteLLM pre-call hook', rows: [{ t: 'trims at 125k tokens (Haiku 95k)', strong: true }, 'no LLM call · cache-stable cut'], accent: true }),
      card(p, { ...M, title: 'Model API', rows: ['Anthropic', 'ChatGPT (Codex)'], chips: true }),
      card(p, { ...S, title: 'Session store', sub: 'SQLite · every turn, verbatim', rows: [{ t: 'smart_compact_search', mono: true }, { t: 'smart_compact_sql', mono: true }], accent: true }),
      card(p, { ...O, title: 'OpenCode 2', sub: 'native plugin, no proxy', rows: ['same trim, same store'] }),
      arrow(p, [[A.x + A.w + 4, A.y + 56], [P.x - 4, A.y + 56]], { label: 'requests', lx: (A.x + A.w + P.x) / 2, ly: A.y + 46 }),
      arrow(p, [[P.x + P.w + 4, P.y + 56], [M.x - 4, P.y + 56]], { label: 'trimmed', lx: (P.x + P.w + M.x) / 2, ly: P.y + 46 }),
      arrow(p, [[P.x + 100, P.y + P.h + 4], [P.x + 100, S.y - 4]], { label: 'every turn', lx: P.x + 110, ly: P.y + P.h + 30, anchor: 'start' }),
      // read back: store -> agent through MCP
      arrow(p, [[S.x - 4, S.y + 70], [300, S.y + 70], [300, A.y + 100], [A.x + A.w + 4, A.y + 100]], { label: 'MCP', lx: 300, ly: A.y + 160 }),
      arrow(p, [[O.x + O.w + 4, O.y + 86], [S.x - 4, O.y + 86]], { dashed: true }),
      contrast(p, M.x, S.y - 2, M.w),
    ].join('');
    return frame(p, W, H, id, 'OpenMem context management', CONTEXT_DESC, body);
  }
  const W = 360, X = 16, CW = 328;
  const parts = [`<text x="${X}" y="28" font-size="15" font-weight="700" fill="${p.ink}">B · Context management</text>`];
  let y = 48;
  parts.push(card(p, { x: X, y, w: CW, h: 67, title: 'Coding agent', rows: ['Claude Code · Codex · OpenCode 1'] }));
  y += 67;
  parts.push(arrow(p, [[W / 2 - 50, y + 4], [W / 2 - 50, y + 30]], { label: 'requests', lx: W / 2 - 38, ly: y + 21, anchor: 'start' }));
  parts.push(arrow(p, [[W / 2 + 70, y + 30], [W / 2 + 70, y + 4]], { label: 'MCP reads', lx: W / 2 + 82, ly: y + 21, anchor: 'start' }));
  y += 34;
  parts.push(card(p, { x: X, y, w: CW, h: 88, title: 'Context proxy', sub: 'LiteLLM pre-call hook', rows: [{ t: 'trims at 125k (Haiku 95k) · no LLM call', strong: true }], accent: true }));
  y += 88;
  const half = (CW - 12) / 2;
  parts.push(arrow(p, [[X + half / 2, y + 4], [X + half / 2, y + 30]], {}));
  parts.push(arrow(p, [[X + half + 12 + half / 2, y + 4], [X + half + 12 + half / 2, y + 30]], {}));
  y += 34;
  parts.push(card(p, { x: X, y, w: half, h: 109, title: 'Model API', rows: ['Anthropic', 'ChatGPT', { t: '(Codex)', dim: true }] }));
  parts.push(card(p, { x: X + half + 12, y, w: half, h: 109, title: 'Session store', rows: ['SQLite, every', 'turn, verbatim'], accent: true }));
  y += 109;
  parts.push(`<text x="${X}" y="${y + 22}" font-size="12" font-weight="600" fill="${p.muted}">agent reads it back over MCP:</text>`);
  parts.push(`<text x="${X}" y="${y + 40}" font-size="12" font-family="${MONO}" fill="${p.ink}">smart_compact_search · smart_compact_sql</text>`);
  y += 50;
  parts.push(arrow(p, [[X + half + 12 + half / 2, y + 30], [X + half + 12 + half / 2, y + 4]], { dashed: true, label: 'same store', lx: X + half + 12 + half / 2 + 10, ly: y + 21, anchor: 'start' }));
  y += 34;
  parts.push(card(p, { x: X, y, w: CW, h: 67, title: 'OpenCode 2', rows: ['native plugin, no proxy'] }));
  y += 83;
  parts.push(contrast(p, X, y, CW));
  y += 130;
  return frame(p, W, y, id, 'OpenMem context management', CONTEXT_DESC, parts.join(''));
}
