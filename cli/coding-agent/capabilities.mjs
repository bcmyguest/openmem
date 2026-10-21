/** Session-memory hook parity vs Hindsight plugin (non-Hindsight uses MCP shim). */

export const AGENT_IDS = Object.freeze(["claude-code", "codex", "opencode", "cursor-cli"]);

/** @typedef {"retain" | "recall" | "reflect" | "consolidate" | "bank_scope"} Feature */

/** @type {Record<string, Partial<Record<Feature, boolean>>>} */
export const PROVIDER_CAPABILITIES = {
  hindsight: { retain: true, recall: true, reflect: true, consolidate: true, bank_scope: true },
  mem0: { retain: true, recall: true, reflect: false, consolidate: false, bank_scope: true },
  cognee: { retain: true, recall: true, reflect: false, consolidate: false, bank_scope: true },
};

/**
 * @param {string} provider
 * @param {Feature} feature
 */
export function providerSupports(provider, feature) {
  return Boolean(PROVIDER_CAPABILITIES[provider]?.[feature]);
}
