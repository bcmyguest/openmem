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
npx @bcmyguest/openmem feed-sync
# checkout: npm run feed-sync
```

Then ensure the stack indexer is running. Each run writes markdown files under `out_dir`; the watcher indexes new/changed files.

Network use: feed-sync calls public RSS/OpenAlex URLs from the host (not from CI by default).

`feed-sync` needs Python 3 with PyYAML on the host. On Windows it uses `py -3`, then `python`; on macOS and Linux it uses `python3`, then `python`. Set `PYTHON` to choose a specific executable.

## Schedule feed sync (optional)

Install an hourly job with the current user's native scheduler. The GitHub npx source works before the next npm release includes `schedule`:

```sh
npx --yes github:bcmyguest/openmem schedule install --dry-run
npx --yes github:bcmyguest/openmem schedule install
npx --yes github:bcmyguest/openmem schedule remove
```

After that release, `npx @bcmyguest/openmem schedule ...` runs the same command from npm.

OpenMem installs a systemd user timer on Linux, a launchd agent on macOS, or a Task Scheduler task on Windows. The job calls the published npm package through a stable runner in your user config directory. Installation records the Python interpreter with PyYAML, so the job does not depend on your interactive shell's PATH. It runs when your user scheduler is active; the Linux timer catches up after downtime. Re-run `schedule install` if you move or upgrade Node.js or Python.
