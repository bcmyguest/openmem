#!/usr/bin/env node
/**
 * Hook access policy: ensure/migrate from legacy ~/.hindsight/coding-agent.json into
 * ~/.config/personal-memory/coding-agent.json, and sync after wizard edits.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  accessAllowed,
  accessConfigPath,
  ensureAccessConfig,
  legacyAccessConfigPath,
  readAccessConfig,
  syncAccessPolicyFromLegacy,
} from "../../cli/coding-agent/access-policy.mjs";

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok    ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pm-access-policy-"));

try {
  {
    const home = path.join(tmp, "missing");
    fs.mkdirSync(home, { recursive: true });
    const dry = ensureAccessConfig(home, { dry: true });
    check("dry-run reports would create", dry.action === "dry-run" && dry.would === "created" && !fs.existsSync(accessConfigPath(home)));
    const created = ensureAccessConfig(home);
    check("creates empty openmem policy", created.action === "created"
      && fs.readFileSync(accessConfigPath(home), "utf8") === "{}\n"
      && accessAllowed("/tmp/any", readAccessConfig(home)));
    check("second ensure is exists", ensureAccessConfig(home).action === "exists");
  }

  {
    const home = path.join(tmp, "migrate");
    fs.mkdirSync(path.join(home, ".hindsight"), { recursive: true });
    const legacy = {
      optInOnly: true,
      optInPaths: ["/home/me/code"],
      mapPathToBank: { "/home/me/code": "coding-agent::code" },
      notebooklmAccess: { enabled: true },
    };
    fs.writeFileSync(legacyAccessConfigPath(home), `${JSON.stringify(legacy, null, 2)}\n`);
    const migrated = ensureAccessConfig(home);
    check("migrates access fields from legacy", migrated.action === "migrated"
      && migrated.config.optInOnly === true
      && migrated.config.optInPaths.join() === "/home/me/code"
      && migrated.config.mapPathToBank["/home/me/code"] === "coding-agent::code");
    const written = JSON.parse(fs.readFileSync(accessConfigPath(home), "utf8"));
    check("does not copy notebooklmAccess into openmem file", !("notebooklmAccess" in written));
    check("migrated opt-in denies /tmp", !accessAllowed("/tmp/x", readAccessConfig(home)));
    check("migrated opt-in allows listed prefix", accessAllowed("/home/me/code/repo", readAccessConfig(home)));
  }

  {
    const home = path.join(tmp, "invalid-legacy");
    fs.mkdirSync(path.join(home, ".hindsight"), { recursive: true });
    fs.writeFileSync(legacyAccessConfigPath(home), `${JSON.stringify({ optInOnly: true, optInPaths: ["relative"] })}\n`);
    const created = ensureAccessConfig(home);
    check("invalid legacy falls back to empty created", created.action === "created"
      && Object.keys(created.config).length === 0
      && accessAllowed("/tmp/x", readAccessConfig(home)));
  }

  {
    const home = path.join(tmp, "sync");
    fs.mkdirSync(path.join(home, ".hindsight"), { recursive: true });
    fs.mkdirSync(path.join(home, ".config", "personal-memory"), { recursive: true });
    fs.writeFileSync(accessConfigPath(home), `${JSON.stringify({ optInOnly: true, optInPaths: ["/old"], keep: "me" }, null, 2)}\n`);
    fs.writeFileSync(legacyAccessConfigPath(home), `${JSON.stringify({
      optInOnly: true, optInPaths: ["/new"], mapPathToBank: { "/new": "coding-agent::new" },
    }, null, 2)}\n`);
    const synced = syncAccessPolicyFromLegacy(home);
    check("sync updates paths from legacy", synced.action === "synced"
      && synced.config.optInPaths.join() === "/new"
      && synced.config.mapPathToBank["/new"] === "coding-agent::new");
    const written = JSON.parse(fs.readFileSync(accessConfigPath(home), "utf8"));
    check("sync preserves unrelated openmem keys", written.keep === "me");
  }

  {
    const home = path.join(tmp, "prefer-existing");
    fs.mkdirSync(path.join(home, ".hindsight"), { recursive: true });
    fs.mkdirSync(path.join(home, ".config", "personal-memory"), { recursive: true });
    fs.writeFileSync(accessConfigPath(home), `${JSON.stringify({ optInOnly: false }, null, 2)}\n`);
    fs.writeFileSync(legacyAccessConfigPath(home), `${JSON.stringify({ optInOnly: true, optInPaths: ["/x"] }, null, 2)}\n`);
    const again = ensureAccessConfig(home);
    check("ensure does not overwrite existing openmem file", again.action === "exists"
      && readAccessConfig(home).optInOnly === false);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failed) {
  console.error(`${failed} failure(s)`);
  process.exit(1);
}
console.log("all ok");
