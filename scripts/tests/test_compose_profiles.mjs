#!/usr/bin/env node
/**
 * composeProfiles + composeSpawnOptions: COMPOSE_PROFILES must match --profile
 * so .env cannot start NotebookLM when the wizard omits it (smoke path).
 */
import { composeArgs, composeProfiles, composeSpawnOptions } from "../../wizard/lib/compose.mjs";

let fails = 0;
function check(desc, ok) {
  if (ok) console.log(`ok    ${desc}`);
  else {
    console.log(`FAIL  ${desc}`);
    fails++;
  }
}

const base = {
  project: "personal-memory",
  repoRoot: "/tmp",
  memoryProvider: { compose: { profile: "hindsight" } },
  extraComposeProfiles: ["ollama", "notebooklm"],
};

check("composeProfiles includes all", composeProfiles(base).join() === "hindsight,ollama,notebooklm");

const withoutNlm = { ...base, extraComposeProfiles: ["ollama"] };
check("omit notebooklm from extras", composeProfiles(withoutNlm).join() === "hindsight,ollama");

const args = composeArgs(withoutNlm, "up", "-d");
check("args have hindsight profile", args.includes("--profile") && args.includes("hindsight"));
check("args have ollama profile", args.includes("ollama"));
check("args omit notebooklm", !args.includes("notebooklm"));

const spawn = composeSpawnOptions(withoutNlm);
check("spawn cwd is repoRoot", spawn.cwd === "/tmp");
check(
  "spawn COMPOSE_PROFILES matches profiles (no notebooklm leak)",
  spawn.env.COMPOSE_PROFILES === "hindsight,ollama",
);

const withNlm = composeSpawnOptions(base);
check("with notebooklm COMPOSE_PROFILES includes it", withNlm.env.COMPOSE_PROFILES === "hindsight,ollama,notebooklm");

if (fails) {
  console.error(`${fails} compose profile test(s) failed`);
  process.exit(1);
}
console.log("all compose profile tests passed");
