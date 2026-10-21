// Single source of truth for branding, URLs, and the install state shown on the
// site. Plain .mjs so build scripts (sync.mjs, check-*.mjs), Astro config, and
// pages all read the same values.
//
// SITE_URL and BASE_PATH override siteUrl and basePath at build time. Use
// BASE_PATH=/ for a custom domain at the root.

export const site = {
  name: 'personal-memory',
  tagline: 'Use the memory system you want — one local setup for coding agents.',
  description:
    'Not locked to one memory product: pick Hindsight, self-hosted mem0, Cognee, or the next manifest — same wizard, shared indexer, switch when you want. Provider status is read from the manifests.',
  repoUrl: 'https://github.com/bcmyguest/personal-memory',
  /** Branch that source links in the docs point at. */
  branch: 'main',
  siteUrl: 'https://bcmyguest.github.io',
  basePath: '/personal-memory/',
  /**
   * npm release state. Keep `published: false` until the package is on the
   * registry; the install section then labels `npx` as not yet available.
   * Flip it in the same change that publishes the first release.
   */
  npm: {
    published: true,
    package: 'personal-memory',
  },
  /** Commands that work from a checkout today (same CLI shape as npx). */
  sourceInstall: {
    clone: 'https://github.com/bcmyguest/personal-memory.git',
    directory: 'personal-memory',
    command: 'npm install && npx . setup',
  },
};
