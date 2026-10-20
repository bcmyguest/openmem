// Single source of truth for branding, URLs, and the install state shown on the
// site. Plain .mjs so build scripts (sync.mjs, check-*.mjs), Astro config, and
// pages all read the same values.
//
// SITE_URL and BASE_PATH override siteUrl and basePath at build time. Use
// BASE_PATH=/ for a custom domain at the root.

export const site = {
  name: 'personal-memory',
  tagline: 'One front door for coding-agent memory on your machine.',
  description:
    'A setup wizard, a Docker Compose stack, and a project and vault indexer that wire coding agents to a pluggable local memory provider. Provider status is read from the provider manifests.',
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
