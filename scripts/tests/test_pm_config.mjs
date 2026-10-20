#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildPmConfigToml,
  defaultsFromPmConfig,
  loadPmConfig,
  userConfigPath,
} from "../../wizard/lib/pm-config.mjs";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const example = path.join(repo, "config/personal-memory.toml.example");
let fails = 0;
function check(desc, ok) {
  if (ok) console.log(`ok    ${desc}`);
  else {
    console.log(`FAIL  ${desc}`);
    fails++;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pm-toml-"));
const home = path.join(tmp, "home");
fs.mkdirSync(path.join(home, ".config/personal-memory"), { recursive: true });
fs.copyFileSync(example, userConfigPath(home));
const loaded = loadPmConfig(home, repo);
check("loads user config.toml", loaded.wroteFrom.includes(userConfigPath(home)));
const d = defaultsFromPmConfig(loaded.merged);
check("example provider hindsight", d.memoryProvider === "hindsight");
check(
  "example model backend lemond",
  String(loaded.merged.model?.backend || "") === "lemond",
);
check("example wizard action configure", d.wizardAction === "configure");

const ctx = {
  home,
  project: "pm-test",
  portApi: "28888",
  portCp: "29999",
  action: "configure",
  memoryProvider: { id: "hindsight" },
  backend: "lemond",
  model: "Gemma-4-E2B-it-GGUF",
  reflectModel: "",
  apiBase: "http://host.docker.internal:13305/v1",
  lemondBase: "http://127.0.0.1:13305",
  dry: true,
};
const out = buildPmConfigToml(ctx);
check("buildPmConfigToml includes provider", out.includes('provider = "hindsight"'));

fs.rmSync(tmp, { recursive: true, force: true });

if (fails) {
  console.log(`${fails} pm config test(s) failed`);
  process.exit(1);
}
console.log("all pm config tests passed");
