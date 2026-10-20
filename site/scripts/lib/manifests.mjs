// Reads providers/*/manifest.json at build time and derives the facts the site
// shows. The site never states a provider's support from prose: the status
// badge, self-host line, and counts all come from these files.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const STATUSES = ['supported', 'experimental', 'planned'];

const STATUS_RANK = { supported: 0, experimental: 1, planned: 2 };

/**
 * @param {unknown} manifest
 * @param {string} where
 */
export function validateManifest(manifest, where) {
  const m = /** @type {any} */ (manifest);
  if (!m || typeof m !== 'object') throw new Error(`${where}: manifest is not an object`);
  for (const key of ['id', 'label']) {
    if (typeof m[key] !== 'string' || !m[key]) throw new Error(`${where}: "${key}" must be a non-empty string`);
  }
  if (!STATUSES.includes(m.status)) {
    throw new Error(`${where}: status "${m.status}" is not one of ${STATUSES.join(', ')}`);
  }
}

/** @param {any} nativeDocs */
function safeHttpUrl(nativeDocs) {
  if (typeof nativeDocs !== 'string') return null;
  try {
    const u = new URL(nativeDocs);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * Plain-language self-host line, derived only from manifest fields.
 * @param {any} m
 */
export function selfHostSummary(m) {
  const services = Array.isArray(m.compose?.services) ? m.compose.services : [];
  if (!services.length) {
    return m.status === 'planned' ? 'Not wired yet: no compose services declared.' : 'No compose services declared.';
  }
  const port = m.compose?.defaultHostPort;
  const env = m.compose?.hostPortEnv;
  const portText = port ? ` Default host port ${port}${env ? ` (${env})` : ''}.` : '';
  return `Docker Compose services: ${services.join(', ')}.${portText}`;
}

/**
 * @param {string} providersDir absolute path of providers/
 */
export function readProviders(providersDir) {
  if (!existsSync(providersDir)) throw new Error(`providers directory not found: ${providersDir}`);
  const providers = [];
  for (const entry of readdirSync(providersDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(providersDir, entry.name, 'manifest.json');
    if (!existsSync(file)) continue;
    const where = `providers/${entry.name}/manifest.json`;
    let m;
    try {
      m = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`${where}: invalid JSON (${/** @type {Error} */ (e).message})`);
    }
    validateManifest(m, where);
    if (m.id !== entry.name) throw new Error(`${where}: id "${m.id}" does not match its directory`);
    providers.push({
      id: m.id,
      label: m.label,
      status: m.status,
      notes: typeof m.notes === 'string' ? m.notes : null,
      selfHost: selfHostSummary(m),
      services: Array.isArray(m.compose?.services) ? m.compose.services : [],
      hostPort: m.compose?.defaultHostPort ?? null,
      hostPortEnv: m.compose?.hostPortEnv ?? null,
      nativeDocs: safeHttpUrl(m.settings?.nativeDocs),
      nativeConfigPaths: Array.isArray(m.settings?.nativeConfigPaths) ? m.settings.nativeConfigPaths : [],
      wizardOwns: Array.isArray(m.settings?.wizardOwns) ? m.settings.wizardOwns : [],
      codingAgentPackage: m.codingAgent?.pluginPackage ?? null,
      sinkDriver: m.indexer?.sinkDriver ?? null,
    });
  }
  providers.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.label.localeCompare(b.label));
  if (!providers.length) throw new Error('no provider manifests found under providers/*/manifest.json');
  return providers;
}
