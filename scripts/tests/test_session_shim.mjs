#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bankFromCwd } from "../../cli/coding-agent/bank-from-cwd.mjs";
import { runHook } from "../../cli/coding-agent/hook-runner.mjs";
import { installSessionShim } from "../../cli/coding-agent/install-shim.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok    ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-bank-"));
  const repo = path.join(dir, "MyRepo");
  fs.mkdirSync(path.join(repo, "nested", "dir"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".git"));
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(repo, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
  check("nested cwd resolves literal repository basename", bankFromCwd(path.join(repo, "nested", "dir"), { home: dir, banks: {} }) === "coding-agent::MyRepo");
  check("index.yml mapping outranks personal mapping", bankFromCwd(repo, {
    home: dir,
    banks: { [repo]: "from-index" },
    mapPathToBank: { [repo]: "from-personal" },
  }) === "from-index");
  fs.mkdirSync(path.join(dir, ".hindsight"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".hindsight", "coding-agent.json"), JSON.stringify({ mapPathToBank: { [repo]: "from-legacy" } }));
  check("legacy indexer map uses the established Hindsight config path", bankFromCwd(repo, { home: dir, banks: {}, mapPathToBank: {} }) === "from-legacy");
  check("longest explicit mapping prefix wins", bankFromCwd(path.join(repo, "nested", "dir"), {
    home: dir,
    banks: { [dir]: "broad", [repo]: "specific" },
  }) === "specific");
  const worktree = path.join(dir, "MyRepo-worktree");
  const worktreeGitDir = path.join(repo, ".git", "worktrees", "MyRepo-worktree");
  fs.mkdirSync(worktreeGitDir, { recursive: true });
  fs.writeFileSync(path.join(worktreeGitDir, "commondir"), "../..");
  fs.mkdirSync(worktree);
  fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);
  check("linked worktree uses common project identity", bankFromCwd(worktree, { home: dir, banks: {} }) === "coding-agent::MyRepo");
  const colonRepo = path.join(dir, "repo:with-colon");
  fs.mkdirSync(path.join(colonRepo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(colonRepo, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(colonRepo, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
  const indexConfig = path.join(dir, "index.yml");
  fs.writeFileSync(indexConfig, `banks:\n  "${colonRepo}": "quoted-colon-bank"\n`);
  check("quoted colon in YAML bank path is parsed", bankFromCwd(colonRepo, {
    home: dir,
    env: { HINDSIGHT_INDEX_CONFIG: indexConfig },
    mapPathToBank: {},
  }) === "quoted-colon-bank");
  fs.writeFileSync(indexConfig, "banks: [unterminated\n");
  let rejectedInvalidYaml = false;
  try {
    bankFromCwd(colonRepo, { home: dir, env: { HINDSIGHT_INDEX_CONFIG: indexConfig }, mapPathToBank: {} });
  } catch { rejectedInvalidYaml = true; }
  check("invalid index YAML is surfaced", rejectedInvalidYaml);
  fs.writeFileSync(indexConfig, `banks:\n  "${colonRepo}": yes\n`);
  let rejectedYaml11Boolean = false;
  try {
    bankFromCwd(colonRepo, { home: dir, env: { HINDSIGHT_INDEX_CONFIG: indexConfig }, mapPathToBank: {} });
  } catch { rejectedYaml11Boolean = true; }
  check("YAML 1.1 boolean bank ids are rejected like PyYAML", rejectedYaml11Boolean);
  fs.writeFileSync(indexConfig, `banks:\n  "${colonRepo}": "yes"\n`);
  check("quoted YAML boolean text remains a bank id", bankFromCwd(colonRepo, {
    home: dir,
    env: { HINDSIGHT_INDEX_CONFIG: indexConfig },
    mapPathToBank: {},
  }) === "yes");
  const tildeRepo = path.join(dir, "Documents", "sample-project");
  fs.mkdirSync(path.join(tildeRepo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(tildeRepo, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(tildeRepo, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
  fs.writeFileSync(indexConfig, "");
  check("empty YAML uses indexer default banks", bankFromCwd(tildeRepo, {
    home: dir,
    env: { HINDSIGHT_INDEX_CONFIG: indexConfig },
    mapPathToBank: {},
  }) === "coding-agent::documents-sample-project");
  const tildeConfig = path.join(dir, "custom", "index.yml");
  fs.mkdirSync(path.dirname(tildeConfig), { recursive: true });
  fs.writeFileSync(tildeConfig, `banks:\n  "${colonRepo}": "tilde-config-bank"\n`);
  check("tilde in HINDSIGHT_INDEX_CONFIG expands under home", bankFromCwd(colonRepo, {
    home: dir,
    env: { HINDSIGHT_INDEX_CONFIG: "~/custom/index.yml" },
    mapPathToBank: {},
  }) === "tilde-config-bank");
  const parent = path.join(dir, "parent-with-git");
  fs.mkdirSync(path.join(parent, ".git"), { recursive: true });
  fs.writeFileSync(path.join(parent, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(parent, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
  check("nonexistent cwd does not inherit a parent repository", bankFromCwd(path.join(parent, "missing-workspace"), { home: dir, banks: {} }) === "coding-agent::missing-workspace");
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pm-shim-"));
  const out = installSessionShim({
    home,
    repoRoot: ROOT,
    agents: ["claude-code"],
    dry: true,
    h: { info: () => {}, ok: () => {}, warn: () => {} },
  });
  check("dry-run lists claude-code", out.installed.includes("claude-code"));

  installSessionShim({
    home,
    repoRoot: ROOT,
    agents: ["claude-code"],
    dry: false,
    h: { info: () => {}, ok: () => {}, warn: () => {} },
  });
  const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude/settings.json"), "utf8"));
  check("claude settings has SessionStart hook", Boolean(settings.hooks?.SessionStart?.[0]?.hooks?.[0]?.command?.includes("hook-runner.mjs")));
}

{
  /** @type {typeof fetch} */
  const fetchFn = async (url, init) => {
    if (String(url).includes("/search")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ provider: "mem0", query: "hi", result: { results: [{ memory: "context hit" }] } }),
      };
    }
    if (String(url).includes("/chat/completions")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: "context hit synthesized" } }] }),
      };
    }
    if (String(url).includes("/memories/recall") || String(url).includes("/memories?")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ provider: "mem0", query: "hi", result: { results: [{ memory: "context hit" }] } }),
      };
    }
    if (String(url).includes("/memories") && init?.method === "POST") {
      return { ok: true, status: 200, text: async () => JSON.stringify({ results: [{ id: "1" }] }) };
    }
    return { ok: false, status: 404, text: async () => "nope" };
  };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pm-shim-run-"));
  fs.mkdirSync(path.join(home, ".config/hindsight"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config/hindsight/wizard.conf"), "MEMORY_PROVIDER=mem0\n");
  const emitted = await runHook(
    "claude-code",
    "prompt",
    {
      home,
      env: { ...process.env, HOME: home, MEMORY_PROVIDER: "mem0", MEM0_API_URL: "http://127.0.0.1:19999" },
      repoRoot: ROOT,
      ev: { cwd: "/tmp/my-repo", prompt: "fix the bug", session_id: "s1" },
      fetchFn,
    },
  );
  check("prompt hook emits additionalContext", Boolean(emitted?.hookSpecificOutput?.additionalContext?.includes("context hit")));
}

{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pm-hook-access-"));
  const configPath = path.join(home, ".config", "personal-memory", "coding-agent.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok: true, status: 200, text: async () => JSON.stringify({ results: [{ memory: "mapped" }] }) };
  };
  const env = { ...process.env, HOME: home, MEMORY_PROVIDER: "mem0", MEM0_API_URL: "http://127.0.0.1:19999" };
  const invoke = (cwd) => runHook("claude-code", "prompt", {
    home, env, repoRoot: ROOT, ev: { cwd, prompt: "remember this" }, fetchFn,
  });

  fs.writeFileSync(configPath, JSON.stringify({ optInOnly: true, optInPaths: [] }));
  await invoke("/tmp/denied-repo");
  check("opt-in denied path makes zero memory calls", calls.length === 0);

  fs.writeFileSync(configPath, JSON.stringify({ optInOnly: true, optInPaths: ["tmp/allowed-repo"] }));
  await invoke("/tmp/allowed-repo");
  check("relative opt-in path does not grant access", calls.length === 0);

  fs.writeFileSync(configPath, JSON.stringify({ disabled: true }));
  await invoke("/tmp/disabled-repo");
  check("disabled hooks make zero memory calls", calls.length === 0);

  fs.writeFileSync(configPath, "{ malformed");
  await invoke("/tmp/malformed-repo");
  check("malformed access config makes zero memory calls", calls.length === 0);

  fs.writeFileSync(configPath, JSON.stringify({}));
  await runHook("claude-code", "prompt", {
    home, env, repoRoot: ROOT, ev: { prompt: "remember this" }, fetchFn,
  });
  check("missing cwd makes zero memory calls", calls.length === 0);

  await runHook("claude-code", "prompt", {
    home, env, repoRoot: ROOT, ev: { cwd: "relative-repo", prompt: "remember this" }, fetchFn,
  });
  check("relative cwd makes zero memory calls", calls.length === 0);

  fs.writeFileSync(configPath, JSON.stringify({
    optInOnly: true,
    optInPaths: ["/tmp/allowed-repo"],
    mapPathToBank: { "/tmp/allowed-repo": "project-memory" },
  }));
  fs.mkdirSync("/tmp/allowed-repo/subdir", { recursive: true });
  fs.mkdirSync("/tmp/allowed-repo/.git", { recursive: true });
  await invoke("/tmp/allowed-repo/subdir");
  check("mapped path selects configured bank", calls.length === 1 && calls[0].body.filters.user_id === "project-memory");
  fs.rmSync("/tmp/allowed-repo", { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log("all session shim tests passed");
