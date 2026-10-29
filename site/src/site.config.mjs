// Single source of truth for branding, URLs, and the install state shown on the
// site. Plain .mjs so build scripts (sync.mjs, check-*.mjs), Astro config, and
// pages all read the same values.
//
// SITE_URL and BASE_PATH override siteUrl and basePath at build time. Use
// BASE_PATH=/ for a custom domain at the root.

export const site = {
  name: 'OpenMem',
  tagline: 'Memory interface for coding agents.',
  description:
    'OpenMem is a memory interface for coding agents — one memory_* API, wizard, and indexer over pluggable providers (Hindsight, mem0, Cognee, …).',
  repoUrl: 'https://github.com/bcmyguest/openmem',
  /** Branch that source links in the docs point at. */
  branch: 'main',
  siteUrl: 'https://bcmyguest.github.io',
  basePath: '/openmem/',
  /**
   * npm release state. Keep `published: false` until the package is on the
   * registry; the install section then labels `npx` as not yet available.
   * Flip it in the same change that publishes the first release.
   */
  npm: {
    published: true,
    package: '@bcmyguest/openmem',
  },
  /** Commands that work from a checkout today (same CLI shape as npx). */
  sourceInstall: {
    clone: 'https://github.com/bcmyguest/openmem.git',
    directory: 'openmem',
    command: 'npm install && npm run setup',
  },
};
