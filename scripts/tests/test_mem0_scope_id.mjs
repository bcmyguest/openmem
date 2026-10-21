#!/usr/bin/env node
import crypto from "node:crypto";
import { mem0ScopeId } from "../../cli/mcp/mem0-scope-id.mjs";

let failed = 0;
function check(name, cond) {
  if (cond) console.log(`ok    ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}`);
  }
}

function digest(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 8);
}

check("identity without whitespace", mem0ScopeId("notebooklm::alpha") === "notebooklm::alpha");
check("My Vault mapping", mem0ScopeId("My Vault") === `My_Vault~${digest("My Vault")}`);

if (failed) process.exit(1);
console.log("all mem0 scope_id tests passed");
