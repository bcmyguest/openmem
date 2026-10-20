#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadManifest } from "../../wizard/lib/providers/registry.mjs";
import {
  listDelegateCommands,
  PROVIDER_PHASES,
} from "../../wizard/lib/provider-wizard/run-steps.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let fails = 0;
function check(desc, ok) {
  if (ok) console.log(`ok    ${desc}`);
  else {
    console.log(`FAIL  ${desc}`);
    fails++;
  }
}

async function loadWizard(id) {
  const manifest = loadManifest(id);
  const modPath = path.join(root, "providers", id, manifest.wizardHooks.module);
  check(`${id} wizard.mjs exists`, fs.existsSync(modPath));
  return import(pathToFileURL(modPath).href);
}

const hindsight = await loadWizard("hindsight");
check("hindsight exports configureModelRouting", typeof hindsight.configureModelRouting === "function");
check("hindsight exports afterProvider", typeof hindsight.afterProvider === "function");

const mem0 = await loadWizard("mem0");
check("mem0 exports configureModelRouting", typeof mem0.configureModelRouting === "function");
const mem0Manifest = loadManifest("mem0");
check("mem0 declares login delegate", listDelegateCommands(mem0Manifest).includes("login"));

check("registry defines provider phases", Object.keys(PROVIDER_PHASES).length >= 5);

if (fails) {
  console.log(`${fails} provider wizard hook test(s) failed`);
  process.exit(1);
}
console.log("all provider wizard hook tests passed");
