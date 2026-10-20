import type { APIRoute } from 'astro';
import { absolute } from '../lib/url';
import { orderedDocs } from '../lib/docs';
import { next, providers, site as brand, STATUS_LABEL, works } from '../lib/content';

export const GET: APIRoute = async ({ site }) => {
  const docs = await orderedDocs();
  const links = docs.map((d) => `- [${d.data.title}](${absolute(`${d.id}.md`, site)}): ${d.data.description ?? ''}`).join('\n');
  const table = providers.map((p) => `- ${p.label} (${p.id}): ${STATUS_LABEL[p.status]}. ${p.selfHost}`).join('\n');
  const text = `# ${brand.name}

> ${brand.description}

Source: ${brand.repoUrl}

## Docs

${links}

## Providers

Generated from providers/*/manifest.json at build time.

${table}

## Works today

${works.map((w) => `- ${w}`).join('\n')}

## Up next

${next.map((n) => `- ${n}`).join('\n')}

## Optional

- [Full docs in one file](${absolute('llms-full.txt', site)})
`;
  return new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
