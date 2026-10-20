#!/usr/bin/env node
import { validateAllProviderManifests } from "../../wizard/lib/validate-setup.mjs";
import { listAllProviders, validateManifest } from "../../wizard/lib/providers/registry.mjs";

let fails = 0;
function check(desc, ok) {
  if (ok) console.log(`ok    ${desc}`);
  else {
    console.log(`FAIL  ${desc}`);
    fails++;
  }
}

const all = validateAllProviderManifests();
check("supported/experimental manifests validate", all.ok);
if (!all.ok) {
  for (const e of all.errors) console.log(`      ${e}`);
}

const hindsight = listAllProviders().find((m) => m.id === "hindsight");
check("hindsight manifest exists", Boolean(hindsight));
check(
  "hindsight smoke paths complete",
  hindsight ? validateManifest(hindsight).length === 0 : false,
);

const mem0 = listAllProviders().find((m) => m.id === "mem0");
check("mem0 manifest exists (planned)", mem0?.status === "planned");
check(
  "mem0 planned skips smoke requirements",
  mem0 ? validateManifest(mem0).length === 0 : false,
);

if (fails) {
  console.log(`${fails} provider manifest test(s) failed`);
  process.exit(1);
}
console.log("all provider manifest tests passed");
