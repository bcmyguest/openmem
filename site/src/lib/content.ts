// Landing and llms.txt copy. Every statement here is taken from the repository
// README and docs/. Provider support is never written by hand: it comes from
// providers/*/manifest.json through src/generated/providers.json.
import providersJson from '../generated/providers.json';
import { site } from '../site.config.mjs';

export type Status = 'supported' | 'experimental' | 'planned';

export interface Provider {
  id: string;
  label: string;
  status: Status;
  notes: string | null;
  selfHost: string;
  services: string[];
  hostPort: number | null;
  hostPortEnv: string | null;
  nativeDocs: string | null;
  nativeConfigPaths: string[];
  wizardOwns: string[];
  codingAgentPackage: string | null;
  sinkDriver: string | null;
}

export const providers = providersJson as Provider[];

export const STATUS_LABEL: Record<Status, string> = {
  supported: 'Supported',
  experimental: 'Experimental',
  planned: 'Planned',
};

const supported = providers.filter((p) => p.status === 'supported');
const experimental = providers.filter((p) => p.status === 'experimental');
const notSupported = providers.filter((p) => p.status !== 'supported');
const names = (list: Provider[]) => list.map((p) => p.label).join(', ');

export const features = [
  {
    title: 'Pluggable providers',
    body: 'Hindsight, mem0, Cognee, or the next manifest. One wizard and indexer; `npx @bcmyguest/openmem switch` rewires compose and MCP. Data stays on each backend until you export/import yourself.',
  },
  {
    title: 'Setup wizard',
    body: 'Preflight, ports, index sources, compose up, health check, smoke retain/recall. Provider hooks in `providers/*/wizard.mjs` add only backend-specific steps.',
  },
  {
    title: 'Compose on loopback',
    body: 'Hindsight publishes API and control on 127.0.0.1. LiteLLM stays on the Docker network as Hindsight’s model proxy.',
  },
  {
    title: 'Multi-source indexer',
    body: 'Git repos (poll), Obsidian vaults, notes/papers/bookmarks folders, and RSS/OpenAlex feed cache (inotify). Tree-sitter outlines for code. One sink for the active provider.',
  },
  {
    title: 'Indexer secret masking',
    body: 'Home is mounted read-only; generated compose overrides hide common credential paths. Writable storage is a named volume.',
  },
  {
    title: 'Smoke test',
    body: 'Temporary bank retain/recall/delete after health passes. Idempotent reruns report changed=0 when nothing moved.',
  },
  {
    title: 'config.toml',
    body: '`~/.config/personal-memory/config.toml` for provider and ports. Day-2: up, down, doctor, install-mcp, switch.',
  },
  {
    title: 'Unified MCP',
    body: '`install-mcp` registers `openmem` with stable `memory_*` tools against the active API. Provider-native MCP (`--provider-only`) and NotebookLM MCP are separate servers.',
  },
  {
    title: 'Manifest-driven site',
    body: 'Provider status badges and copy on this site are generated from `providers/*/manifest.json` at build time.',
  },
  {
    title: 'NotebookLM (opt-in)',
    body: 'Compose profile syncs into the active provider; optional MCP for list/search. Off until you enable sync.',
    tag: 'Opt-in',
  },
];

export const steps = [
  { n: '1', title: 'Pick a provider', body: 'Run the wizard and choose a stack action and a memory provider. Defaults come from your config file.' },
  { n: '2', title: 'Configure', body: 'The wizard checks Docker and ports, writes env files with mode 600 outside the repository, and wires the provider.' },
  { n: '3', title: 'Start the stack', body: 'It builds the indexer only when its inputs changed, starts Compose, and waits for the health check.' },
  { n: '4', title: 'Index', body: 'The indexer reads index.yml, finds repositories and vaults, and writes them to the active provider.' },
  { n: '5', title: 'Smoke test', body: 'A retain and recall round trip in a temporary bank confirms the provider answers before you rely on it.' },
];

export const works = [
  'Interactive and non-interactive wizard: configure, start, stop, --yes, --dry-run',
  `Provider manifests drive this site: ${supported.length ? `supported today: ${names(supported)}` : 'no provider is supported yet'}${experimental.length ? `; experimental: ${names(experimental)}` : ''}`,
  'Hindsight stack through Docker Compose, with a LiteLLM proxy in front of lemond, Ollama, or a custom endpoint',
  'mem0 (URL-only) and Cognee (pinned Docker image) compose profiles with provider wizard hooks and indexer sinks',
  'Indexer for git repositories and Obsidian vaults, with tree-sitter outlines and secret-path masking',
  'Smoke retain and recall, and an idempotent rerun that reports changed=N',
  'Declarative config.toml and npx @bcmyguest/openmem tasks: up, down, doctor, install-mcp, switch',
  'Unified openmem MCP (memory_add/search/recall/forget, PMM export/import) via install-mcp',
  'Opt-in NotebookLM sync; install-mcp also registers the NotebookLM MCP when enabled',
  'Provider-native MCP (mem0/Cognee) still available with install-mcp --provider-only',
];

export const next = [
  'PMM import: mem0 duplicate detection; richer Cognee export (full document text)',
  ...notSupported.map((p) => `${p.label}: manifest status is ${p.status}`),
  'Live end-to-end runs against real mem0 and Cognee servers (required before supported)',
  site.npm.published ? 'Further npm releases' : `The first npm release, which makes npx ${site.npm.package} work`,
];

export const security = [
  {
    title: 'Loopback binds',
    body: 'The Hindsight API (127.0.0.1:8888) and control plane (127.0.0.1:9999) publish on loopback only. The LiteLLM proxy is on the internal Docker network and is not published.',
  },
  {
    title: 'Secret masking in the indexer',
    body: 'The indexer sees your home directory read-only. A generated compose.override.yaml masks secret paths such as ~/.ssh and ~/.gnupg. Only paths that exist when it is generated are masked, so rerun the generator after adding a secret directory.',
  },
  {
    title: 'Secrets stay out of the repository',
    body: 'Env files live under ~/.config/hindsight with mode 600. LiteLLM routes read keys from environment variables, so route YAML holds no secrets.',
  },
  {
    title: 'Nothing leaves the machine unless a provider says so',
    body: 'Indexed text goes to the provider and the model server you configured. A hosted model route or the NotebookLM sync sends data to those services; a local route does not.',
  },
  {
    title: 'This site',
    body: 'Static pages with self-hosted fonts: no analytics and no third-party requests. The build fails if the output contains home paths, private IPs, host aliases, or secret-style assignments.',
  },
];

export { site };
