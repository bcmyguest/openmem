#!/usr/bin/env node
/** Codex wiring for the context proxy: ~/.codex/config.toml `model_provider` + `[model_providers.openmem]`. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import TOML from "@iarna/toml";
import {
  CODEX_PROVIDER_ID,
  agentsPointedAtContextProxy,
  codexConfigPath,
  contextProxyBackupPath,
  contextProxyEnvPath,
  installContextProxy,
} from "../../cli/coding-agent/install-context-proxy.mjs";

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok    ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

delete process.env.OPENMEM_STATE_DIR;
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "openmem-cp-codex-"));
const read = (home) => fs.readFileSync(codexConfigPath(home), "utf8");
const write = (home, text) => {
  fs.mkdirSync(path.dirname(codexConfigPath(home)), { recursive: true });
  fs.writeFileSync(codexConfigPath(home), text, { mode: 0o644 });
};
const masterKey = (home) => fs.readFileSync(contextProxyEnvPath(home), "utf8").match(/^LITELLM_MASTER_KEY=(.+)$/m)[1];
const logs = () => {
  const lines = [];
  return { lines, info: (m) => lines.push(m), ok: (m) => lines.push(m), warn: (m) => lines.push(`WARN ${m}`) };
};

// Fresh home: provider entry, ChatGPT login kept, key header, mode 600.
{
  const home = tmpHome();
  const out = installContextProxy({ home, agents: ["codex"], enabled: true, port: 4100 });
  const cfg = TOML.parse(read(home));
  const ours = cfg.model_providers?.[CODEX_PROVIDER_ID] || {};
  check("enable reports codex changed", out.changed.includes("codex"), JSON.stringify(out));
  check("model_provider selects the openmem provider", cfg.model_provider === CODEX_PROVIDER_ID);
  check("base_url is the subscription pass-through", ours.base_url === "http://127.0.0.1:4100/backend-api/codex", ours.base_url);
  check("provider keeps the ChatGPT login and speaks Responses over HTTP",
    ours.requires_openai_auth === true && ours.wire_api === "responses" && ours.supports_websockets === false);
  check("http_headers carries the LiteLLM key", ours.http_headers?.["x-litellm-api-key"] === `Bearer ${masterKey(home)}`);
  check("config.toml holding the key is mode 600", (fs.statSync(codexConfigPath(home)).mode & 0o777) === 0o600);
  check("no backup without a previous model_provider", !fs.existsSync(contextProxyBackupPath(home)));
  check("agentsPointedAtContextProxy names codex", agentsPointedAtContextProxy(home).includes("codex"));
  installContextProxy({ home, agents: ["codex"], enabled: false, port: 4100 });
  check("disable on a fresh home leaves an empty config", read(home) === "", JSON.stringify(read(home)));
  check("disable unpoints codex", !agentsPointedAtContextProxy(home).includes("codex"));
  fs.rmSync(home, { recursive: true, force: true });
}

// Existing config: foreign model_provider backed up and restored byte for byte; other entries untouched.
{
  const home = tmpHome();
  const original = [
    "# my codex config",
    'model = "gpt-6-sol"',
    'model_provider = "ollama"',
    "",
    "[features]",
    "hooks = true",
    "",
    "[mcp_servers.openmem]",
    'command = "node"',
    'args = ["/x/openmem-mcp.mjs"]',
    "",
  ].join("\n");
  write(home, original);
  installContextProxy({ home, agents: ["codex"], enabled: true, port: 4200 });
  const once = read(home);
  const cfg = TOML.parse(once);
  check("foreign model_provider is replaced", cfg.model_provider === CODEX_PROVIDER_ID);
  check("other keys and tables are kept", cfg.model === "gpt-6-sol" && cfg.features?.hooks === true && cfg.mcp_servers?.openmem?.command === "node");
  check("model_provider stays top-level, after the existing top-level keys",
    once.startsWith('# my codex config\nmodel = "gpt-6-sol"\nmodel_provider = "openmem"\n\n[features]'), once.slice(0, 120));
  const backup = JSON.parse(fs.readFileSync(contextProxyBackupPath(home), "utf8"));
  check("previous model_provider is backed up", backup.codex?.model_provider === "ollama", JSON.stringify(backup));
  installContextProxy({ home, agents: ["codex"], enabled: true, port: 4200 });
  check("re-enable is idempotent", read(home) === once);
  check("re-enable keeps the original backup", JSON.parse(fs.readFileSync(contextProxyBackupPath(home), "utf8")).codex?.model_provider === "ollama");
  installContextProxy({ home, agents: ["codex"], enabled: true, port: 4300 });
  check("port change rewrites base_url only once", (read(home).match(/\[model_providers\.openmem\]/g) || []).length === 1
    && TOML.parse(read(home)).model_providers.openmem.base_url.endsWith(":4300/backend-api/codex"));
  installContextProxy({ home, agents: ["codex"], enabled: false, port: 4300 });
  check("disable restores the original file", read(home) === original, JSON.stringify(read(home)));
  check("disable removes the backup entry", !fs.existsSync(contextProxyBackupPath(home)));
  fs.rmSync(home, { recursive: true, force: true });
}

// Not ours: disable leaves it alone; per-agent off leaves an unpointed config alone.
{
  const home = tmpHome();
  const text = 'model_provider = "openai"\n';
  write(home, text);
  const out = installContextProxy({ home, agents: ["codex"], enabled: false, port: 4100 });
  check("disable without our wiring changes nothing", read(home) === text && !out.changed.includes("codex"));
  installContextProxy({ home, agents: ["claude-code", "codex"], enabled: true, agentEnabled: { codex: false }, port: 4100 });
  check("codex = false with enabled = true leaves Codex unpointed", read(home) === text);
  fs.rmSync(home, { recursive: true, force: true });
}

// A config the TOML parser rejects is left unchanged with a warning.
{
  const home = tmpHome();
  write(home, "model = \n[broken\n");
  const log = logs();
  const out = installContextProxy({ home, agents: ["codex"], enabled: true, port: 4100, h: log });
  check("malformed config.toml is left unchanged", read(home) === "model = \n[broken\n" && !out.changed.includes("codex"));
  check("malformed config.toml is reported", log.lines.some((l) => l.startsWith("WARN codex: left")), log.lines.join("\n"));
  check("malformed config.toml does not count as pointed", !agentsPointedAtContextProxy(home).includes("codex"));
  fs.rmSync(home, { recursive: true, force: true });
}

// Dry run names the pass-through URL and writes nothing.
{
  const home = tmpHome();
  const log = logs();
  installContextProxy({ home, agents: ["codex"], enabled: true, port: 4100, dry: true, h: log });
  check("dry run plans the codex pass-through URL", log.lines.some((l) => l === "[dry-run] point codex at context proxy http://127.0.0.1:4100/backend-api/codex"), log.lines.join("\n"));
  check("dry run writes no config.toml", !fs.existsSync(codexConfigPath(home)));
  fs.rmSync(home, { recursive: true, force: true });
}

// The service is needed for Codex alone.
{
  const { proxyServiceNeeded, CONTEXT_AGENT_ROUTE } = await import("../../cli/context-management.mjs");
  check("codex alone needs the context-proxy service", proxyServiceNeeded({ codex: true }) && !proxyServiceNeeded({ codex: false, opencode2: true }));
  check("status names the codex route", /backend-api\/codex/.test(CONTEXT_AGENT_ROUTE.codex));
}

if (failed) process.exit(1);
console.log("all context proxy codex tests passed");
