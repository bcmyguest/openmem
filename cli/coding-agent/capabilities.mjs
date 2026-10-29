/** Session-memory hook parity vs Hindsight plugin (non-Hindsight uses MCP shim). */

import { CODING_AGENTS, DEFAULT_AGENT_IDS } from "./agents.mjs";

export const AGENT_IDS = Object.freeze(CODING_AGENTS.map((a) => a.id));
export { DEFAULT_AGENT_IDS };

/**
 * @typedef {"retain" | "recall" | "reflect" | "consolidate" | "bank_scope" | "knowledge_pages" | "initiatives" | "ingest_status"} Feature
 */

/** @type {Record<string, Partial<Record<Feature, boolean>>>} */
export const PROVIDER_CAPABILITIES = {
  hindsight: {
    retain: true,
    recall: true,
    reflect: true,
    consolidate: true,
    bank_scope: true,
    knowledge_pages: true,
    initiatives: true,
    ingest_status: true,
  },
  mem0: { retain: true, recall: true, reflect: true, consolidate: false, bank_scope: true, ingest_status: true },
  cognee: { retain: true, recall: true, reflect: true, consolidate: true, bank_scope: true },
};

/**
 * @param {string} provider
 * @param {Feature} feature
 */
export function providerSupports(provider, feature) {
  return Boolean(PROVIDER_CAPABILITIES[provider]?.[feature]);
}
