/**
 * The shared indexer's container entry point. The wizard runs it with --list to preview
 * which sources an index.yml selects. PM_INDEXER_BIN overrides the name if the entry
 * point is renamed.
 */
export const INDEXER_BIN = process.env.PM_INDEXER_BIN || "hindsight-project-index";
