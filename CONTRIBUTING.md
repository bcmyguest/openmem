# Contributing

Contributions and pull requests are welcome.

Before proposing a change, read the relevant implementation and its surrounding code. Understand the data flow and existing behavior before editing; use the [architecture](docs/architecture.md), [concepts](docs/concepts.md), and provider guides as entry points when useful. Keep changes focused and update the documentation when behavior or setup changes.

## Before opening a pull request

1. Describe the problem and intended behavior. For a new provider or a change to an existing provider boundary, read [Pluggable memory providers](docs/memory-providers.md) first.
2. Run the checks relevant to your change. The full Node and wizard suite is `npm test`; the indexer suite is `npm run test:indexer`; package contents are checked with `npm run pack:check`.
3. Include the checks you ran and any known limitations in the pull request description.

Open a pull request against `main`. Link related issues or discussions when available. Keep the pull request focused so reviewers can follow the behavior from the entry point through the affected implementation.
