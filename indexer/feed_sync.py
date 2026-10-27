#!/usr/bin/env python3
"""Fetch RSS and OpenAlex query results into markdown under feeds.out_dir for the indexer."""

from __future__ import annotations

import hashlib
import json
import re
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

import index_config

USER_AGENT = "openmem-feed-sync/1.0"


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "feed"


def fetch_bytes(url: str, timeout: int = 60) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def write_markdown(out_dir: Path, bank_slug: str, title: str, body: str, source_url: str) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(source_url.encode()).hexdigest()[:12]
    safe = slugify(title)[:60] or digest
    path = out_dir / f"{bank_slug}--{safe}--{digest}.md"
    text = f"---\nsource_url: {source_url}\nfeed_bank: feed::{bank_slug}\n---\n\n# {title}\n\n{body.strip()}\n"
    path.write_text(text, encoding="utf-8")
    return path


def sync_rss(url: str, out_dir: Path, slug: str | None = None) -> int:
    bank_slug = slug or slugify(urllib.parse.urlparse(url).path or "rss")
    raw = fetch_bytes(url)
    root = ET.fromstring(raw)
    channel = root.find("channel") or root
    items = channel.findall("item") if channel is not None else root.findall(".//item")
    count = 0
    for item in items[:50]:
        title = (item.findtext("title") or "untitled").strip()
        link = (item.findtext("link") or "").strip()
        desc = (item.findtext("description") or item.findtext("{http://www.w3.org/2005/Atom}summary") or "").strip()
        desc = re.sub(r"<[^>]+>", " ", desc)
        if not link:
            continue
        write_markdown(out_dir, bank_slug, title, desc or title, link)
        count += 1
    return count


def sync_openalex(query_url: str, out_dir: Path, slug: str | None = None) -> int:
    bank_slug = slug or "openalex"
    raw = fetch_bytes(query_url)
    data = json.loads(raw.decode())
    results = data.get("results") or []
    count = 0
    for work in results[:40]:
        title = work.get("title") or work.get("display_name") or "work"
        wid = work.get("id") or ""
        abstract = work.get("abstract_inverted_index")
        body = title
        if isinstance(abstract, dict):
            words = sorted(abstract.items(), key=lambda kv: kv[1][0] if kv[1] else 0)
            body = " ".join(w for w, _ in words)
        doi = (work.get("doi") or wid) or title
        write_markdown(out_dir, bank_slug, title, body, str(doi))
        count += 1
    return count


def run(config: index_config.Config | None = None) -> int:
    config = config or index_config.load()
    feeds = getattr(config, "feeds_out_dir", None)
    if feeds is None:
        print("feeds: nothing configured (feeds.rss / feeds.openalex_queries empty)", file=sys.stderr)
        return 0
    out_dir = feeds
    total = 0
    for entry in config.feeds_rss:
        url = entry if isinstance(entry, str) else entry.get("url", "")
        slug = None if isinstance(entry, str) else entry.get("slug")
        if not url:
            continue
        n = sync_rss(url, out_dir, slug)
        print(f"rss {url}: {n} items -> {out_dir}")
        total += n
    for entry in config.feeds_openalex_queries:
        url = entry if isinstance(entry, str) else entry.get("url", "")
        slug = None if isinstance(entry, str) else entry.get("slug")
        if not url:
            continue
        n = sync_openalex(url, out_dir, slug)
        print(f"openalex {url}: {n} works -> {out_dir}")
        total += n
    return 0 if total >= 0 else 1


if __name__ == "__main__":
    raise SystemExit(run())
