# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/bcmyguest/personal-memory/security/advisories/new).
Do not open a public issue. Expect a first reply within 14 days.

## Supported versions

Only the latest release receives fixes.

## Scope notes

- The wizard writes secrets (the LiteLLM master key, provider API keys) under
  `~/.config/hindsight/` with mode `0600` (directory `0700`). The npm package ships no
  secrets and no machine-specific files; `npm run pack:check` fails the build if a
  `.env`, `machine.env`, `compose.override.yaml` or a home-directory path would be packed.
- The stack root (`$PM_STACK_ROOT`, default `~/.local/share/personal-memory/stack`) holds
  generated files such as `.env` and `compose.override.yaml`. Upgrades overwrite only
  files the package ships and you did not modify, and never touch generated files.
- The indexer container mounts `$HOME` read-only and masks well-known credential paths
  through the generated `compose.override.yaml`. Anything under `$HOME` that is not on
  that list is readable by the indexer and can be sent to the configured memory provider
  and model backend. Review `config/index.yml` and the mask list before pointing it at a
  home directory that holds other secrets.
- Memory services bind to `127.0.0.1` by default. Binding them to another interface
  (for example `compose.bench.yaml`, which also binds the docker0 gateway) makes them
  reachable from that network; check that provider's authentication first.
- Releases are published from CI with npm trusted publishing and provenance; the
  `npm` environment requires approval.
