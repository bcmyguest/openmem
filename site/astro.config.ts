import { existsSync, readFileSync } from 'node:fs';
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import mermaid from 'astro-mermaid';
import tailwindcss from '@tailwindcss/vite';
import { site as brand } from './src/site.config.mjs';

// SITE_URL / BASE_PATH let one build target either host:
//   GitHub Pages project site (default): SITE_URL=https://bcmyguest.github.io BASE_PATH=/personal-memory/
//   Custom domain at the root:           SITE_URL=https://your.domain BASE_PATH=/
const siteUrl = process.env.SITE_URL || brand.siteUrl;
const basePath = process.env.BASE_PATH || brand.basePath;
const root = basePath.replace(/\/$/, '');

// The sidebar is derived from the pages scripts/sync.mjs actually generated, so
// an absent optional doc never leaves a dead sidebar entry.
const docsJson = new URL('./src/generated/docs.json', import.meta.url);
if (!existsSync(docsJson)) throw new Error('src/generated/docs.json is missing: run `pnpm sync` (or `pnpm build`, which does).');
const pages: { slug: string; group: string; title: string }[] = JSON.parse(readFileSync(docsJson, 'utf8'));
const groups = [...new Set(pages.map((p) => p.group))];
const sidebar = groups.map((label) => ({
  label,
  items: pages.filter((p) => p.group === label).map((p) => ({ label: p.title, slug: `docs/${p.slug}` })),
}));

const ogImage = new URL(`${root}/og.png`, siteUrl).href;

export default defineConfig({
  site: siteUrl,
  base: basePath,
  trailingSlash: 'ignore',
  integrations: [
    mermaid({ autoTheme: true, enableLog: false }),
    starlight({
      title: brand.name,
      description: brand.description,
      favicon: '/favicon.svg',
      logo: { src: './src/assets/logo.svg', alt: '' },
      customCss: ['@fontsource/dm-sans/400.css', '@fontsource/dm-sans/600.css', './src/styles/tokens.css', './src/styles/docs.css'],
      social: [{ icon: 'github', label: 'Source repository', href: brand.repoUrl }],
      head: [
        { tag: 'meta', attrs: { property: 'og:image', content: ogImage } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: ogImage } },
      ],
      sidebar,
      routeMiddleware: './src/routeData.ts',
      lastUpdated: false,
      pagination: true,
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
