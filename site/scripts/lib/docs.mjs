// Turns repository docs/*.md into Starlight pages: drops the H1 (Starlight
// renders the title), rewrites relative links, and adds frontmatter. Pure
// functions; the filesystem work lives in sync.mjs.
import { posix } from 'node:path';

/**
 * Every docs page, in sidebar order. `kind`:
 *  - hand: committed in src/content/docs/docs/ (not touched by sync)
 *  - doc: generated from a repository doc (`source`); `optional` sources are
 *    skipped when absent (another worker may not have written them yet)
 *  - manifest: generated from providers/*\/manifest.json
 *
 * Developer-only guides (setup-wizard, memory-providers, hooks, manual compose,
 * indexing internals) stay in the git repo under docs/ and are not listed here.
 */
export const PAGES = [
  {
    slug: 'concepts',
    kind: 'doc',
    source: 'docs/concepts.md',
    group: 'Start',
    title: 'Concepts',
    description:
      'OpenMem as a memory interface for coding agents — providers, memory_* API, banks, and formats.',
  },
  {
    slug: 'getting-started',
    kind: 'doc',
    source: 'docs/quickstart.md',
    group: 'Start',
    title: 'Quickstart',
    description: 'Run the wizard once (npx or git checkout), verify health, optional MCP install.',
  },
  {
    slug: 'npx-install',
    kind: 'doc',
    source: 'docs/npx-install.md',
    group: 'Start',
    optional: true,
    title: 'Install with npx',
    description: 'Install and run the openmem wizard through npx.',
  },
  {
    slug: 'architecture',
    kind: 'doc',
    source: 'docs/architecture.md',
    group: 'Start',
    title: 'Architecture',
    description: 'Runtime data flow, how changes update memory, and MCP access per provider.',
  },
  {
    slug: 'mcp-setup',
    kind: 'doc',
    source: 'docs/mcp-setup.md',
    group: 'Start',
    title: 'MCP setup',
    description: 'Install unified memory_* MCP, optional provider-native servers, and NotebookLM.',
  },
  {
    slug: 'compatibility',
    kind: 'doc',
    source: 'docs/compatibility.md',
    group: 'Start',
    optional: true,
    title: 'Compatibility',
    description: 'What each coding agent, memory provider, and Hindsight model backend supports, with evidence level.',
  },
  {
    slug: 'context-management',
    kind: 'doc',
    source: 'docs/context-management.md',
    group: 'Features',
    optional: true,
    title: 'Context management',
    description: 'Smart compaction: benchmarks, what it trims, how to turn it on or off, per-agent support, tools, and config keys.',
  },
  {
    slug: 'provider-status',
    kind: 'manifest',
    group: 'Providers',
    title: 'Provider status',
    description: 'Every provider, its status, and its self-host story, generated from the provider manifests.',
  },
  {
    slug: 'hindsight',
    kind: 'doc',
    source: 'docs/hindsight.md',
    group: 'Providers',
    title: 'Hindsight',
    description: 'Default Compose stack, LiteLLM, loopback API, session hooks, and optional plugin.',
  },
  {
    slug: 'model-configuration',
    kind: 'doc',
    source: 'docs/model-configuration.md',
    group: 'Providers',
    optional: true,
    title: 'Model configuration',
    description: 'LiteLLM aliases and backends for Hindsight retain, reflect, and consolidate.',
  },
  {
    slug: 'mem0',
    kind: 'doc',
    source: 'docs/mem0.md',
    group: 'Providers',
    optional: true,
    title: 'mem0',
    description: 'Self-hosted mem0 REST with OpenMem indexer, unified memory_* MCP, and PMM portability.',
  },
  {
    slug: 'cognee',
    kind: 'doc',
    source: 'docs/cognee.md',
    group: 'Providers',
    optional: true,
    title: 'Cognee',
    description: 'Loopback Cognee container, REST ingest, and read-only MCP tools.',
  },
  {
    slug: 'memory-portability',
    kind: 'doc',
    source: 'docs/memory-portability.md',
    group: 'Reference',
    optional: true,
    title: 'Portable memory (PMM)',
    description: 'PMM export/import format and unified MCP memory_export / memory_import behavior.',
  },
  {
    slug: 'openmem-config',
    kind: 'doc',
    source: 'docs/openmem-config.md',
    group: 'Reference',
    title: 'Configuration file',
    description: 'The mise-like config.toml: files, precedence, sections, and the pm tasks.',
  },
  {
    slug: 'context-proxy',
    kind: 'doc',
    source: 'docs/context-proxy.md',
    group: 'Reference',
    optional: true,
    title: 'Context proxy',
    description: 'Local LiteLLM proxy that trims long agent sessions, compresses tool results, and injects recall.',
  },
  {
    slug: 'context-research',
    kind: 'doc',
    source: 'docs/context-research.md',
    group: 'Reference',
    optional: true,
    title: 'Context research',
    description: 'Related work (MemGPT, Letta, Mainplane, Context Rot) and benchmark evidence behind the context proxy.',
  },
  {
    slug: 'index-sources',
    kind: 'doc',
    source: 'docs/index-sources.md',
    group: 'Reference',
    optional: true,
    title: 'Index sources',
    description: 'Git, Obsidian, notes, papers, bookmarks, and feed cache banks for the shared indexer.',
  },
  {
    slug: 'sources-feeds',
    kind: 'doc',
    source: 'docs/sources-feeds.md',
    group: 'Reference',
    optional: true,
    title: 'Feed sync',
    description: 'RSS and OpenAlex queries into a watched markdown cache for feed::* banks.',
  },
  {
    slug: 'sources-zotero',
    kind: 'doc',
    source: 'docs/sources-zotero.md',
    group: 'Reference',
    optional: true,
    title: 'Zotero exports',
    description: 'Point papers.paths at Zotero markdown export folders.',
  },
  {
    slug: 'sources-readwise',
    kind: 'doc',
    source: 'docs/sources-readwise.md',
    group: 'Reference',
    optional: true,
    title: 'Readwise exports',
    description: 'Readwise markdown export directories as notes or papers sources.',
  },
];

/**
 * Replace text segments outside fenced code and inline code with fn(segment).
 * @param {string} md
 * @param {(s: string) => string} fn
 */
export function mapProse(md, fn) {
  const lines = md.split('\n');
  const out = [];
  let fence = null;
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    // Mask inline code spans so links inside them stay literal, while a code
    // span inside link text still survives the rewrite.
    const spans = [];
    const masked = buf.join('\n').replace(/(`+)[^`\n]*?\1/g, (m) => `\u0000${spans.push(m) - 1}\u0000`);
    out.push(fn(masked).replace(/\u0000(\d+)\u0000/g, (_m, i) => spans[Number(i)]));
    buf = [];
  };
  for (const line of lines) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === null) {
        flush();
        fence = f[1][0];
        out.push(line);
      } else if (f[1][0] === fence) {
        out.push(line);
        fence = null;
      } else out.push(line);
    } else if (fence !== null) out.push(line);
    else buf.push(line);
  }
  flush();
  return out.join('\n');
}

/**
 * Rewrite relative Markdown links.
 *  - a link to another published doc becomes a site-relative page link
 *  - any other existing repository path becomes a GitHub blob/tree URL
 *  - a link to a missing path throws, so a broken link fails the build
 *
 * @param {string} md
 * @param {object} ctx
 * @param {string} ctx.sourcePath repo-relative path of the source file, e.g. docs/a.md
 * @param {Map<string, string>} ctx.published repo-relative source path -> slug
 * @param {(repoPath: string) => 'file' | 'dir' | null} ctx.kindOf
 * @param {string} ctx.repoUrl
 * @param {string} ctx.branch
 */
export function rewriteLinks(md, { sourcePath, published, kindOf, repoUrl, branch }) {
  const dir = posix.dirname(sourcePath);
  return mapProse(md, (prose) =>
    prose.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g, (whole, bang, text, href, title) => {
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)) return whole;
      if (href.startsWith('/')) return whole;
      const [pathPart, hash = ''] = href.split(/#(.*)/s);
      const decoded = decodeURI(pathPart);
      const target = posix.normalize(posix.join(dir, decoded));
      if (target.startsWith('..')) throw new Error(`${sourcePath}: link "${href}" leaves the repository`);
      const slug = published.get(target);
      if (slug) return `${bang}[${text}](../${slug}/${hash ? `#${hash}` : ''}${title})`;
      const kind = kindOf(target);
      if (!kind) throw new Error(`${sourcePath}: link "${href}" points to ${target}, which does not exist`);
      const where = `${repoUrl}/${kind === 'dir' ? 'tree' : 'blob'}/${branch}/${target.replace(/\/$/, '')}`;
      return `${bang}[${text}](${where}${hash ? `#${hash}` : ''}${title})`;
    }),
  );
}

const PICTURE = /<picture>\s*<source media="\(prefers-color-scheme: dark\)" srcset="([^"]+)"\s*\/?>\s*<img src="([^"]+)" alt="([^"]*)"\s*\/?>\s*<\/picture>/g;

/**
 * Turn GitHub-style light/dark `<picture>` blocks into the site's theme-toggled duo (`pm-diagram-duo`),
 * and make image URLs under the published site (`siteRoot`, e.g. https://host/openmem/) relative to
 * `basePath`, so the docs build serves the copy it deploys. Repository markdown keeps the absolute URLs,
 * which GitHub renders. Other pictures are left alone.
 * @param {string} md
 * @param {{ siteRoot: string, basePath: string }} opts
 */
export function pictureToDuo(md, { siteRoot, basePath }) {
  const root = siteRoot.replace(/\/?$/, '/');
  const base = basePath.replace(/\/?$/, '/');
  const local = (u) => (u.startsWith(root) ? `${base}${u.slice(root.length)}` : u);
  return md.replace(
    PICTURE,
    (_m, dark, light, alt) =>
      `<div class="pm-diagram-duo">\n<img class="pm-diagram-light" src="${local(light)}" alt="${alt}" />\n<img class="pm-diagram-dark" src="${local(dark)}" alt="${alt}" />\n</div>`,
  );
}

/** First `# ` heading, with Markdown code ticks removed, or null. */
export function firstHeading(md) {
  const m = /^#\s+(.+?)\s*$/m.exec(md);
  return m ? m[1].replace(/`/g, '').trim() : null;
}

/** Drop the leading H1; Starlight renders the title from frontmatter. */
export function stripH1(md) {
  return md.replace(/^\s*#\s+.+\n+/, '');
}

/** Quote a scalar for YAML frontmatter. */
export function yamlString(s) {
  return JSON.stringify(s);
}

/**
 * @param {{ title: string, description: string }} meta
 * @param {string} body
 */
export function withFrontmatter({ title, description }, body) {
  return `---\ntitle: ${yamlString(title)}\ndescription: ${yamlString(description)}\n---\n\n${body.trim()}\n`;
}
