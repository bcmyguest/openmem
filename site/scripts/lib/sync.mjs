// Build-time sync: provider manifests and repository docs -> generated site
// inputs. Fails the build on a privacy finding in a published source, a broken
// relative link, or an invalid manifest. It redacts nothing.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PAGES, firstHeading, rewriteLinks, stripH1, withFrontmatter } from './docs.mjs';
import { readProviders } from './manifests.mjs';
import { applyAllowlist, formatFinding, scanText, validateAllowlist } from './privacy.mjs';

/** Read the allowlist and deny list that both scans share. */
export function loadPrivacyConfig(siteRoot, env = process.env) {
  const allowFile = join(siteRoot, 'scripts', 'privacy-allowlist.json');
  const allowlist = existsSync(allowFile) ? validateAllowlist(JSON.parse(readFileSync(allowFile, 'utf8'))) : [];
  const denyFile = join(siteRoot, '.privacy-deny.local');
  const deny = [...(existsSync(denyFile) ? readFileSync(denyFile, 'utf8').split('\n') : []), ...(env.PRIVACY_DENY ?? '').split(',')]
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));
  return { allowlist, deny };
}

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

const STATUS_TEXT = { supported: 'Supported', experimental: 'Experimental', planned: 'Planned' };

/** Markdown for the Provider status page. */
export function providerStatusMarkdown(providers) {
  const rows = providers.map((p) => {
    const docs = p.nativeDocs ? `[${new URL(p.nativeDocs).host}](${p.nativeDocs})` : 'none listed';
    return `| ${cell(p.label)} | ${STATUS_TEXT[p.status]} | ${cell(p.selfHost)} | ${docs} |`;
  });
  const details = providers.map((p) => {
    const lines = [`## ${p.label}`, '', `- Status: **${STATUS_TEXT[p.status]}** (\`status\` in \`providers/${p.id}/manifest.json\`).`];
    if (p.notes) lines.push(`- Notes: ${cell(p.notes)}`);
    lines.push(`- Self-host: ${cell(p.selfHost)}`);
    if (p.sinkDriver) lines.push(`- Indexer sink driver id: \`${p.sinkDriver}\`.`);
    if (p.codingAgentPackage) lines.push(`- Coding-agent package: \`${p.codingAgentPackage}\`, installed separately.`);
    if (p.nativeConfigPaths.length) lines.push(`- Provider-native config: ${p.nativeConfigPaths.map((x) => `\`${x}\``).join(', ')}.`);
    if (p.wizardOwns.length) lines.push(`- The wizard owns: ${p.wizardOwns.map(cell).join('; ')}.`);
    return lines.join('\n');
  });
  return `This page is generated at build time from \`providers/*/manifest.json\`. If a provider is not **Supported** here, do not rely on it.

| Provider | Status | Self-host | Native docs |
| --- | --- | --- | --- |
${rows.join('\n')}

${details.join('\n\n')}
`;
}

/**
 * @param {{ repoRoot: string, siteRoot: string, repoUrl: string, branch: string, log?: (s: string) => void }} opts
 */
export function runSync({ repoRoot, siteRoot, repoUrl, branch, log = () => {} }) {
  const generatedDir = join(siteRoot, 'src', 'generated');
  const docsOut = join(siteRoot, 'src', 'content', 'docs', 'docs');
  mkdirSync(generatedDir, { recursive: true });
  mkdirSync(docsOut, { recursive: true });

  const providers = readProviders(join(repoRoot, 'providers'));
  writeFileSync(join(generatedDir, 'providers.json'), `${JSON.stringify(providers, null, 2)}\n`);
  log(`providers: ${providers.map((p) => `${p.id}=${p.status}`).join(', ')}`);

  const { allowlist, deny } = loadPrivacyConfig(siteRoot);
  const published = new Map(PAGES.filter((p) => p.kind === 'doc' && existsSync(join(repoRoot, p.source))).map((p) => [p.source, p.slug]));
  const kindOf = (repoPath) => {
    const abs = join(repoRoot, repoPath);
    if (!existsSync(abs)) return null;
    return statSync(abs).isDirectory() ? 'dir' : 'file';
  };

  const findings = [];
  const pages = [];
  for (const page of PAGES) {
    if (page.kind === 'hand') {
      if (!existsSync(join(docsOut, `${page.slug}.md`))) throw new Error(`missing hand-written page ${page.slug}.md`);
      pages.push(page);
      continue;
    }
    const out = join(docsOut, `${page.slug}.md`);
    if (page.kind === 'manifest') {
      const md = providerStatusMarkdown(providers);
      findings.push(...scanText(md, { kind: 'md', file: `providers/*/manifest.json (${page.slug})`, deny }));
      writeFileSync(out, withFrontmatter(page, md));
      pages.push(page);
      continue;
    }
    if (!existsSync(join(repoRoot, page.source))) {
      if (!page.optional) throw new Error(`required doc source is missing: ${page.source}`);
      rmSync(out, { force: true });
      log(`skipped optional ${page.source} (not present)`);
      continue;
    }
    const raw = readFileSync(join(repoRoot, page.source), 'utf8');
    findings.push(...scanText(raw, { kind: 'md', file: page.source, deny }));
    const title = page.slug === 'npx-install' ? (firstHeading(raw) ?? page.title) : page.title;
    const body = rewriteLinks(stripH1(raw), { sourcePath: page.source, published, kindOf, repoUrl, branch });
    const footer = `\n\n---\n\nThis page is generated from [\`${page.source}\`](${repoUrl}/blob/${branch}/${page.source}) in the repository.`;
    writeFileSync(out, withFrontmatter({ title, description: page.description }, body + footer));
    pages.push({ ...page, title });
    log(`page ${page.slug} <- ${page.source}`);
  }

  const { blocking, allowed, unused } = applyAllowlist(findings, allowlist);
  for (const e of unused) log(`warning: privacy allowlist entry not used (${e.rule} ${JSON.stringify(e.match)})`);
  if (allowed.length) log(`privacy: ${allowed.length} allowlisted source match(es)`);
  if (blocking.length) {
    const lines = blocking.map(formatFinding).join('\n');
    throw new Error(
      `privacy: ${blocking.length} finding(s) in published doc sources. Fix the source docs; the site does not redact.\n${lines}`,
    );
  }

  writeFileSync(
    join(generatedDir, 'docs.json'),
    `${JSON.stringify(pages.map(({ slug, group, title, description }) => ({ slug, group, title, description })), null, 2)}\n`,
  );

  // Drop stale generated pages (including slugs removed from PAGES); hand-written pages stay.
  const keep = new Set(pages.map((p) => `${p.slug}.md`));
  const handSlugs = new Set(PAGES.filter((p) => p.kind === 'hand').map((p) => `${p.slug}.md`));
  for (const f of readdirSync(docsOut)) {
    if (!f.endsWith('.md') || handSlugs.has(f) || keep.has(f)) continue;
    rmSync(join(docsOut, f));
    log(`removed stale page ${f}`);
  }
  return { providers, pages };
}
