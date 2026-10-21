# Session scopes (banks, user_id, datasets)

One **scope key** is reused across indexer, unified MCP, and (where supported) the coding-agent path.

| Provider | Indexer bank example | MCP `bank` argument | Notes |
| --- | --- | --- | --- |
| Hindsight | `coding-agent::my-repo` | same bank string | Plugin uses Hindsight banks |
| mem0 | same bank string | maps to `user_id` | `memory_add` sets `user_id=bank` |
| Cognee | same bank string | maps to dataset name | See `cognee-dataset-name` in export code |

Default when tools omit `bank`: **`personal-memory-mcp`**.

Configure what gets indexed in `~/.config/hindsight/index.yml`. Optional filters in
`~/.hindsight/coding-agent.json` (`optInPaths`) limit which discovered sources are indexed.

Future: `[session]` section in `~/.config/personal-memory/config.toml` may pin a default scope per repo; not required today.
