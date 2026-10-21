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
    title: 'Any memory system you choose',
    body: 'Not one vendor’s stack. Pick Hindsight, self-hosted mem0, Cognee, or the next manifest — same wizard and indexer. Switch with npx personal-memory switch; memories stay on the old backend until you migrate yourself.',
  },
  {
    title: 'One wizard, per-provider steps',
    body: 'npx personal-memory asks for a stack action and a provider, then runs shared steps: preflight, ports, index sources, start, health, smoke test. Provider hooks add only what that backend needs.',
  },
  {
    title: 'A Compose stack, loopback only',
    body: 'The Hindsight stack is a LiteLLM proxy on the internal Docker network, the Hindsight API, and the indexer. The API and control plane publish on 127.0.0.1 only.',
  },
  {
    title: 'Project and vault indexer',
    body: 'Indexes git repositories and Obsidian vaults, then keeps them current: repositories are polled, vaults are watched. Code files get tree-sitter outlines for 14 languages, with no network needed.',
  },
  {
    title: 'Secret paths masked',
    body: 'The indexer mounts your home directory read-only and a generated override hides ~/.ssh, ~/.gnupg, ~/.config/hindsight, and the Codex and Claude credential files. Its one writable path is a named volume.',
  },
  {
    title: 'Smoke test on every start',
    body: 'After the stack is healthy the wizard retains a fact in a temporary bank, recalls it, and deletes the bank. A rerun on an unchanged setup reports changed=0.',
  },
  {
    title: 'Declarative config',
    body: 'A mise-like ~/.config/personal-memory/config.toml holds provider, ports, and model routing. Day-2 commands are npx personal-memory up, down, doctor, install-mcp, and switch.',
  },
  {
    title: 'Switch providers later',
    body: 'Try mem0 without abandoning Hindsight config: npx personal-memory switch <provider> --yes rewires compose, env, and MCP. No forced migration — your data stays where you left it on each backend.',
  },
  {
    title: 'Local models by default',
    body: 'For Hindsight, three LiteLLM aliases map retain, reflect, and consolidate to lemond, Ollama, or any OpenAI-compatible server. No cloud account is involved unless you point a route at one.',
  },
  {
    title: 'Manifests, not guesses',
    body: 'Each provider declares its status, compose services, health check, and native docs in a manifest. This site reads those files at build time, so a provider only shows as supported when its manifest says so.',
  },
  {
    title: 'Optional NotebookLM sync + MCP',
    body: 'An opt-in compose profile syncs Google NotebookLM into notebooklm::* banks. Agents can list/search those banks via an opt-in stdio MCP (fast full-text by default). Off until you enable sync and notebooklmAccess.',
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
  'Declarative config.toml and npx personal-memory tasks: up, down, doctor, install-mcp, switch',
  'Unified personal-memory MCP (memory_add/search/recall/forget, PMM export/import) via install-mcp',
  'Opt-in NotebookLM sync; install-mcp also registers the NotebookLM MCP when enabled',
  'Provider-native MCP (mem0/Cognee) still available with install-mcp --provider-only',
];

export const next = [
  'PMM export/import: Hindsight list export and Cognee dataset export',
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
