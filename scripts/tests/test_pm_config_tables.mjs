#!/usr/bin/env node
/** Installer-owned config.toml tables: [agents] and [context_proxy]. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import TOML from "@iarna/toml";
import {
  agentIntegrationFromPmConfig,
  contextProxyFromPmConfig,
  syncPmConfig,
  updatePmConfigTable,
  userConfigPath,
} from "../../wizard/lib/pm-config.mjs";

let fails = 0;
function check(desc, ok) {
  if (ok) console.log(`ok    ${desc}`);
  else {
    console.log(`FAIL  ${desc}`);
    fails++;
  }
}

check("integration defaults to openmem", agentIntegrationFromPmConfig({}) === "openmem");
check("integration reads provider", agentIntegrationFromPmConfig({ agents: { integration: "provider" } }) === "provider");
check("unknown integration falls back to openmem", agentIntegrationFromPmConfig({ agents: { integration: "other" } }) === "openmem");
check("context proxy defaults", JSON.stringify(contextProxyFromPmConfig({})) === JSON.stringify({ enabled: false, port: 4100 }));
check("context proxy reads table", JSON.stringify(contextProxyFromPmConfig({ context_proxy: { enabled: true, port: 4200 } })) === JSON.stringify({ enabled: true, port: 4200 }));

const home = fs.mkdtempSync(path.join(os.tmpdir(), "pm-toml-tables-"));
const file = userConfigPath(home);
check("dry-run writes nothing", updatePmConfigTable(home, "agents", { integration: "provider" }, { dry: true }) === "dry-run" && !fs.existsSync(file));
updatePmConfigTable(home, "agents", { integration: "provider" });
updatePmConfigTable(home, "context_proxy", { enabled: true });
let doc = TOML.parse(fs.readFileSync(file, "utf8"));
check("tables created in a new file", doc.agents.integration === "provider" && doc.context_proxy.enabled === true);
check("new config is mode 600 in a 700 directory", (fs.statSync(file).mode & 0o777) === 0o600 && (fs.statSync(path.dirname(file)).mode & 0o777) === 0o700);

syncPmConfig({ home, project: "p", action: "configure", memoryProvider: { id: "hindsight" }, dry: false });
doc = TOML.parse(fs.readFileSync(file, "utf8"));
check("wizard rewrite keeps installer tables", doc.agents?.integration === "provider" && doc.context_proxy?.enabled === true && doc.memory.provider === "hindsight");

fs.rmSync(home, { recursive: true, force: true });
if (fails) {
  console.log(`${fails} pm config table test(s) failed`);
  process.exit(1);
}
console.log("all pm config table tests passed");
