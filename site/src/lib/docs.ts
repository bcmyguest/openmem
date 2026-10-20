import { getCollection, type CollectionEntry } from 'astro:content';
import pageList from '../generated/docs.json';

/** Docs pages in sidebar order (the order scripts/sync.mjs generated). */
export async function orderedDocs(): Promise<CollectionEntry<'docs'>[]> {
  const docs = (await getCollection('docs')).filter((d) => d.id.startsWith('docs/'));
  const rank = (d: CollectionEntry<'docs'>) => pageList.findIndex((p) => `docs/${p.slug}` === d.id);
  return docs.sort((a, b) => rank(a) - rank(b));
}
