"""feed_sync.py with mocked HTTP."""

from unittest.mock import patch

import index_config
from feed_sync import sync_rss, write_markdown


RSS = b"""<?xml version="1.0"?>
<rss><channel><item>
<title>Test Paper</title>
<link>https://example.com/paper/1</link>
<description>Abstract here</description>
</item></channel></rss>"""


def test_write_markdown(tmp_path):
    p = write_markdown(tmp_path, "arxiv", "Test Paper", "body", "https://example.com/paper/1")
    assert p.exists()
    assert "feed::arxiv" in p.read_text()


def test_sync_rss_mock(tmp_path):
    with patch("feed_sync.fetch_bytes", return_value=RSS):
        n = sync_rss("https://example.com/feed", tmp_path, "test")
    assert n == 1
    assert list(tmp_path.glob("*.md"))


def test_config_feeds_parse(home, monkeypatch):
    monkeypatch.setenv("HOME", str(home))
    cfg = index_config.parse(
        {
            "feeds": {
                "out_dir": "~/feeds-cache",
                "rss": [{"url": "https://example.com/rss", "slug": "ex"}],
            }
        },
        source="test",
    )
    assert cfg.feeds_out_dir == home / "feeds-cache"
    assert len(cfg.feeds_rss) == 1
    assert ("feed", home / "feeds-cache") in cfg.markdown_sources()
