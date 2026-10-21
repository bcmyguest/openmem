#!/usr/bin/env node
import { CODING_AGENTS } from "../../cli/coding-agent/agents.mjs";
import { AGENT_IDS, DEFAULT_AGENT_IDS, PROVIDER_CAPABILITIES } from "../../cli/coding-agent/capabilities.mjs";

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok    ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

check("AGENT_IDS matches CODING_AGENTS", AGENT_IDS.length === CODING_AGENTS.length);
for (const id of ["claude-code", "hermes", "amp", "cline"]) {
  check(`registry includes ${id}`, AGENT_IDS.includes(id));
}
check("DEFAULT_AGENT_IDS are hindsight-installable", DEFAULT_AGENT_IDS.every((id) => CODING_AGENTS.find((a) => a.id === id)?.hindsightInstall));
check("mem0 lacks reflect", PROVIDER_CAPABILITIES.mem0.reflect === false);
check("hindsight has reflect", PROVIDER_CAPABILITIES.hindsight.reflect === true);

if (failed) process.exit(1);
console.log("all coding-agent registry tests passed");
