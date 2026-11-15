#!/usr/bin/env node
/** autoRegisterLocation: opt-in git repos on session start, unless opted out. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  accessAllowed,
  accessConfigPath,
  autoRegisterLocation,
  readAccessConfig,
} from "../../cli/coding-agent/access-policy.mjs";

const BANKS = {};

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok    ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

function gitRepo(dir) {
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(dir, ".git", "config"), "");
  return dir;
}

function writePolicy(home, config) {
  fs.mkdirSync(path.dirname(accessConfigPath(home)), { recursive: true });
  fs.writeFileSync(accessConfigPath(home), `${JSON.stringify(config, null, 2)}\n`);
}

function setup(name, config) {
  const home = path.join(tmp, name, "home");
  fs.mkdirSync(home, { recursive: true });
  if (config !== undefined) writePolicy(home, config);
  return home;
}

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pm-auto-register-")));

try {
  {
    const home = setup("registers", { optInOnly: true, optInPaths: [] });
    const repo = gitRepo(path.join(tmp, "registers", "code", "alpha"));
    const sub = path.join(repo, "src", "lib");
    fs.mkdirSync(sub, { recursive: true });
    const r = autoRegisterLocation(sub, { home, banks: BANKS });
    const cfg = readAccessConfig(home);
    check("registers the git root, not the subdirectory", r.action === "registered" && r.path === repo
      && cfg.optInPaths.join() === repo, JSON.stringify(r));
    check("maps the root to its own bank", cfg.mapPathToBank[repo] === "coding-agent::alpha"
      && r.bank === "coding-agent::alpha", JSON.stringify(cfg.mapPathToBank));
    check("subdirectory is then allowed", accessAllowed(sub, cfg));
    check("second call is a no-op", autoRegisterLocation(sub, { home, banks: BANKS }).action === "covered");
    check("keeps optInOnly", cfg.optInOnly === true);
  }

  {
    const home = setup("worktree", { optInOnly: true, optInPaths: [] });
    const main = gitRepo(path.join(tmp, "worktree", "code", "beta"));
    const gitDir = path.join(main, ".git", "worktrees", "beta-feature");
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/feature\n");
    fs.writeFileSync(path.join(gitDir, "commondir"), "../..\n");
    const wt = path.join(tmp, "worktree", "code", "beta-feature");
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${gitDir}\n`);
    const r = autoRegisterLocation(wt, { home, banks: BANKS });
    check("linked worktree shares the main repo's bank", r.action === "registered" && r.path === wt
      && readAccessConfig(home).mapPathToBank[wt] === "coding-agent::beta", JSON.stringify(r));
  }

  {
    const home = setup("existing-map", { optInOnly: true, optInPaths: [], mapPathToBank: {} });
    const repo = gitRepo(path.join(tmp, "existing-map", "code", "gamma"));
    writePolicy(home, { optInOnly: true, optInPaths: [], mapPathToBank: { [path.dirname(repo)]: "coding-agent::shared" } });
    const r = autoRegisterLocation(repo, { home, banks: BANKS });
    const cfg = readAccessConfig(home);
    check("an existing mapping covering the repo is kept", r.action === "registered"
      && Object.keys(cfg.mapPathToBank).length === 1 && r.bank === "coding-agent::shared", JSON.stringify(cfg));
  }

  {
    const home = setup("opt-out-global", { optInOnly: true, optInPaths: [], autoRegister: false });
    const repo = gitRepo(path.join(tmp, "opt-out-global", "code", "delta"));
    const r = autoRegisterLocation(repo, { home, banks: BANKS });
    check("autoRegister: false skips", r.action === "skipped" && r.reason === "opted-out"
      && readAccessConfig(home).optInPaths.length === 0, JSON.stringify(r));
  }

  {
    const code = path.join(tmp, "opt-out-path", "code");
    const home = setup("opt-out-path", { optInOnly: true, optInPaths: [], optOutPaths: [code] });
    const repo = gitRepo(path.join(code, "epsilon"));
    const r = autoRegisterLocation(repo, { home, banks: BANKS });
    check("a repo under optOutPaths is skipped", r.action === "skipped" && r.reason === "opted-out"
      && readAccessConfig(home).optInPaths.length === 0, JSON.stringify(r));
  }

  {
    const home = setup("not-git", { optInOnly: true, optInPaths: [] });
    const dir = path.join(tmp, "not-git", "scratch");
    fs.mkdirSync(dir, { recursive: true });
    const r = autoRegisterLocation(dir, { home, banks: BANKS });
    check("a directory outside git is skipped", r.action === "skipped" && r.reason === "not-git", JSON.stringify(r));
  }

  {
    const home = setup("home-repo", { optInOnly: true, optInPaths: [] });
    gitRepo(home);
    const dir = path.join(home, "notes");
    fs.mkdirSync(dir, { recursive: true });
    const r = autoRegisterLocation(dir, { home, banks: BANKS });
    check("a git repo at $HOME is never registered", r.action === "skipped" && r.reason === "home"
      && readAccessConfig(home).optInPaths.length === 0, JSON.stringify(r));
  }

  {
    const home = setup("disabled", { disabled: true, optInOnly: true, optInPaths: [] });
    const repo = gitRepo(path.join(tmp, "disabled", "code", "zeta"));
    const r = autoRegisterLocation(repo, { home, banks: BANKS });
    check("disabled hooks skip registration", r.action === "skipped" && r.reason === "disabled", JSON.stringify(r));
  }

  {
    const home = setup("malformed");
    fs.mkdirSync(path.dirname(accessConfigPath(home)), { recursive: true });
    fs.writeFileSync(accessConfigPath(home), "{ not json");
    const repo = gitRepo(path.join(tmp, "malformed", "code", "eta"));
    const r = autoRegisterLocation(repo, { home, banks: BANKS });
    check("a malformed policy is left untouched", r.action === "skipped" && r.reason === "invalid-config"
      && fs.readFileSync(accessConfigPath(home), "utf8") === "{ not json", JSON.stringify(r));
  }

  {
    const home = setup("open", { optInOnly: false });
    const repo = gitRepo(path.join(tmp, "open", "code", "theta"));
    const r = autoRegisterLocation(repo, { home, banks: BANKS });
    const cfg = readAccessConfig(home);
    check("without optInOnly the repo is still pinned to its bank", r.action === "registered"
      && cfg.mapPathToBank[repo] === "coding-agent::theta" && cfg.optInOnly === false, JSON.stringify(cfg));
  }

  {
    const home = setup("dry", { optInOnly: true, optInPaths: [] });
    const repo = gitRepo(path.join(tmp, "dry", "code", "iota"));
    const before = fs.readFileSync(accessConfigPath(home), "utf8");
    const r = autoRegisterLocation(repo, { home, banks: BANKS, dry: true });
    check("dry run writes nothing", r.action === "dry-run" && fs.readFileSync(accessConfigPath(home), "utf8") === before);
  }

  {
    const home = setup("validation", { optInOnly: true, optOutPaths: ["relative/path"] });
    check("relative optOutPaths make the policy invalid", readAccessConfig(home) === null);
    writePolicy(home, { autoRegister: "no" });
    check("non-boolean autoRegister makes the policy invalid", readAccessConfig(home) === null);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failed) {
  console.error(`${failed} failure(s)`);
  process.exit(1);
}
console.log("all ok");
