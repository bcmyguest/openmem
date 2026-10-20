import type { APIRoute } from 'astro';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { providers, site, STATUS_LABEL } from '../lib/content';

// Build-time Open Graph image (1200x630). The provider chips come from the
// manifests, so the image cannot claim support the manifests do not declare.
const require = createRequire(import.meta.url);
const font = (weight: number) => readFileSync(require.resolve(`@fontsource/dm-sans/files/dm-sans-latin-${weight}-normal.woff`));

type Node = { type: string; props: Record<string, unknown> };
const h = (type: string, style: Record<string, unknown>, children?: unknown): Node => ({
  type,
  props: { style, children },
});

const chip = (label: string, status: keyof typeof STATUS_LABEL) => {
  const supported = status === 'supported';
  return h(
    'div',
    {
      display: 'flex',
      marginRight: 16,
      padding: '10px 22px',
      borderRadius: 12,
      fontSize: 26,
      fontWeight: 700,
      border: `2px ${status === 'planned' ? 'dashed' : 'solid'} ${supported ? '#aab4f6' : '#343a54'}`,
      background: supported ? '#262d55' : '#171a25',
      color: supported ? '#eceef7' : '#b4b9d0',
    },
    `${label}: ${STATUS_LABEL[status]}`,
  );
};

export const GET: APIRoute = async () => {
  const tree = h(
    'div',
    {
      // Satori sizes boxes content-box: 1200x630 minus 2x72 padding.
      width: 1056,
      height: 486,
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      padding: 72,
      background: '#0f1118',
      color: '#eceef7',
      fontFamily: 'DM Sans',
    },
    [
      h('div', { display: 'flex', fontSize: 34, fontWeight: 700, color: '#aab4f6' }, site.name),
      h('div', { display: 'flex', fontSize: 60, fontWeight: 700, lineHeight: 1.15, maxWidth: 1000 }, site.tagline),
      h(
        'div',
        { display: 'flex', flexDirection: 'row', alignItems: 'center', width: '100%' },
        providers.slice(0, 3).map((p) => chip(p.label, p.status)),
      ),
    ],
  );
  const svg = await satori(tree as never, {
    width: 1200,
    height: 630,
    fonts: [
      { name: 'DM Sans', data: font(400), weight: 400, style: 'normal' },
      { name: 'DM Sans', data: font(700), weight: 700, style: 'normal' },
    ],
  });
  const png = new Resvg(svg).render().asPng();
  return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } });
};
