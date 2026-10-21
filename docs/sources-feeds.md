# RSS and OpenAlex feeds

Configure `feeds` in `index.yml`, run sync, then the indexer watches `feeds.out_dir` as kind **feed** (`feed::*` banks).

```yaml
feeds:
  out_dir: ~/.local/share/personal-memory/feeds
  rss:
    - url: https://rss.arxiv.org/rss/cs.AI
      slug: arxiv-cs-ai
  openalex_queries:
    - url: https://api.openalex.org/works?search=machine%20learning&per_page=25
      slug: openalex-ml
```

```sh
npx personal-memory feed-sync
# checkout: npm run feed-sync
```

Then ensure the stack indexer is running. Each run writes markdown files under `out_dir`; the watcher indexes new/changed files.

Network use: feed-sync calls public RSS/OpenAlex URLs from the host (not from CI by default).
