#!/usr/bin/env node
/**
 * Unit tests for cli/install-memory-mcp.mjs: arg parsing, provider detection,
 * NotebookLM detection, and MCP merge dry-run (scratch HOME, no live Cursor).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cogneeMcpStubEntry,
  mem0McpEntry,
  mem0McpPlaceholderEntry,
  mergeNamedMcpServer,
  notebooklmEnabledInYml,
  parseInstallMcpArgs,
  resolveMem0ApiUrl,
  resolveMemoryProvider,
  runInstallMemoryMcp,
  shouldInstallNotebooklm,
} from "../../cli/install-memory-mcp.mjs";
import { mem0McpScriptPath } from "../../providers/mem0/lib/mcp-install.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok    ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

const tmpRoots = [];
function tmp(label) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `pm-install-mcp-${label}-`));
  tmpRoots.push(d);
  return d;
}
process.on("exit", () => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});

// --- arg parsing ---
{
  const a = parseInstallMcpArgs(["--yes", "--dry-run", "--notebooklm"]);
  check("parse --yes", a.yes === true);
  check("parse --dry-run", a.dry === true);
  check("parse --notebooklm", a.notebooklm === true);
  check("parse defaults off", a.notebooklmOnly === false && a.providerOnly === false && a.help === false);

  const b = parseInstallMcpArgs(["--notebooklm-only", "-y"]);
  check("parse --notebooklm-only and -y", b.notebooklmOnly && b.yes);

  const c = parseInstallMcpArgs(["--provider-only", "--help"]);
  check("parse --provider-only --help", c.providerOnly && c.help);

  const d = parseInstallMcpArgs(["--bogus", "x"]);
  check("parse collects unknown", d.unknown.join(",") === "--bogus,x");
}

// --- provider detection ---
{
  const home = tmp("prov");
  fs.mkdirSync(path.join(home, ".config/hindsight"), { recursive: true });
  check("provider defaults to hindsight", resolveMemoryProvider(home, {}) === "hindsight");
  check(
    "provider from MEMORY_PROVIDER env",
    resolveMemoryProvider(home, { MEMORY_PROVIDER: "mem0" }) === "mem0",
  );
  fs.writeFileSync(path.join(home, ".config/hindsight/wizard.conf"), "MEMORY_PROVIDER=cognee\n");
  check(
    "provider from wizard.conf when env unset",
    resolveMemoryProvider(home, {}) === "cognee",
  );
  check(
    "env beats wizard.conf",
    resolveMemoryProvider(home, { MEMORY_PROVIDER: "hindsight" }) === "hindsight",
  );
}

// --- notebooklm detection ---
{
  const home = tmp("nlm");
  const yml = path.join(home, ".config/hindsight/notebooklm.yml");
  fs.mkdirSync(path.dirname(yml), { recursive: true });
  check("notebooklm yml missing → false", notebooklmEnabledInYml(yml) === false);
  fs.writeFileSync(yml, "enabled: false\n");
  check("notebooklm enabled false", notebooklmEnabledInYml(yml) === false);
  fs.writeFileSync(yml, "enabled: true\ninterval_minutes: 60\n");
  check("notebooklm enabled true", notebooklmEnabledInYml(yml) === true);

  const flagsOff = parseInstallMcpArgs([]);
  check(
    "shouldInstall when yml enabled",
    shouldInstallNotebooklm({ home, flags: flagsOff }) === true,
  );
  check(
    "provider-only skips notebooklm",
    shouldInstallNotebooklm({ home, flags: parseInstallMcpArgs(["--provider-only"]) }) === false,
  );
  const home2 = tmp("nlm2");
  fs.mkdirSync(path.join(home2, ".config/hindsight"), { recursive: true });
  check(
    "--notebooklm forces without yml",
    shouldInstallNotebooklm({ home: home2, flags: parseInstallMcpArgs(["--notebooklm"]) }) === true,
  );
}

// --- mem0 URL resolution (no secrets) ---
{
  const home = tmp("mem0url");
  const stack = tmp("stack");
  fs.mkdirSync(path.join(home, ".config/hindsight"), { recursive: true });
  fs.writeFileSync(path.join(stack, ".env"), "MEM0_API_URL=http://127.0.0.1:19999\nMEM0_API_KEY=secret-should-not-leak\n");
  const url = resolveMem0ApiUrl({ home, stackRoot: stack, env: {} });
  check("mem0 URL from stack .env", url === "http://127.0.0.1:19999");
  const entry = mem0McpPlaceholderEntry(url);
  check(
    "mem0 entry has no API key field",
    !("MEM0_API_KEY" in entry.env) && entry.env.MEM0_API_URL === url && entry.env.MEM0_BASE_URL === url,
  );
  check("mem0 entry uses node launcher", entry.command === "node" && String(entry.args?.[0] || "").endsWith("cli/mem0-mcp.mjs"));
}

// --- merge helpers preserve siblings ---
{
  const base = {
    mcpServers: {
      hindsight: { command: "node", args: ["/h.js"] },
      codegraph: { command: "codegraph", args: ["serve"] },
      notebooklm: { command: "node", args: ["/n.js"] },
    },
  };
  const mem0 = mem0McpEntry({
    apiUrl: "http://127.0.0.1:18888",
    scriptPath: mem0McpScriptPath(ROOT),
  });
  const { mcp, changed } = mergeNamedMcpServer(base, "mem0", mem0);
  check("merge mem0 adds entry", changed && mcp.mcpServers.mem0.command === "node");
  check("merge mem0 keeps hindsight", mcp.mcpServers.hindsight === base.mcpServers.hindsight);
  check("merge mem0 keeps codegraph", mcp.mcpServers.codegraph === base.mcpServers.codegraph);
  check("merge mem0 keeps notebooklm", mcp.mcpServers.notebooklm === base.mcpServers.notebooklm);

  const again = mergeNamedMcpServer(mcp, "mem0", mem0);
  check("merge mem0 idempotent", again.changed === false);

  const refused = mergeNamedMcpServer(base, "hindsight", { command: "evil" });
  check("merge refuses protected hindsight name", Boolean(refused.refused) && refused.changed === false);

  const script = path.join(ROOT, "cli/cognee-mcp.mjs");
  const stub = cogneeMcpStubEntry(script, "http://127.0.0.1:8766");
  const c = mergeNamedMcpServer(base, "cognee", stub);
  check("merge cognee entry", c.changed && c.mcp.mcpServers.cognee.args[0] === script);
  check("cognee entry has COGNEE_API_URL only", c.mcp.mcpServers.cognee.env?.COGNEE_API_URL === "http://127.0.0.1:8766");
  check("cognee entry has no API key", !("COGNEE_API_KEY" in (c.mcp.mcpServers.cognee.env || {})));
  check("cognee merge keeps notebooklm", c.mcp.mcpServers.notebooklm === base.mcpServers.notebooklm);
}

// --- dry-run install (scratch HOME) ---
{
  const home = tmp("dry");
  const stack = tmp("dry-stack");
  fs.mkdirSync(path.join(home, ".config/hindsight"), { recursive: true });
  fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config/hindsight/wizard.conf"), "MEMORY_PROVIDER=mem0\n");
  fs.writeFileSync(path.join(stack, ".env"), "MEM0_API_URL=http://127.0.0.1:18888\n");
  const mcpPath = path.join(home, ".cursor/mcp.json");
  fs.writeFileSync(
    mcpPath,
    JSON.stringify(
      {
        mcpServers: {
          hindsight: { command: "keep-me" },
          codegraph: { command: "keep-cg" },
        },
      },
      null,
      2,
    ),
  );
  const before = fs.readFileSync(mcpPath, "utf8");
  const logs = [];
  const h = {
    info: (m) => logs.push(`info:${m}`),
    ok: (m) => logs.push(`ok:${m}`),
    warn: (m) => logs.push(`warn:${m}`),
  };
  const result = await runInstallMemoryMcp({
    home,
    repoRoot: ROOT,
    stackRoot: stack,
    flags: parseInstallMcpArgs(["--dry-run", "--yes", "--provider-only"]),
    env: {},
    h,
  });
  check("dry-run provider is mem0", result.provider === "mem0");
  check("dry-run didProvider", result.didProvider === true);
  check("dry-run skipped notebooklm", result.didNotebooklm === false);
  check("dry-run did not rewrite mcp.json", fs.readFileSync(mcpPath, "utf8") === before);
  check(
    "dry-run log mentions mem0 merge",
    logs.some((l) => /dry-run.*mem0|mem0 MCP/i.test(l)),
    logs.join("|"),
  );
  check(
    "dry-run never logs secret values from .env",
    !logs.some((l) => /secret-should-not-leak/i.test(l)),
  );
}

// --- dry-run notebooklm-only ---
{
  const home = tmp("nlm-dry");
  fs.mkdirSync(path.join(home, ".config/hindsight"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config/hindsight/notebooklm.yml"), "enabled: true\n");
  const logs = [];
  const result = await runInstallMemoryMcp({
    home,
    repoRoot: ROOT,
    stackRoot: home,
    flags: parseInstallMcpArgs(["--dry-run", "--yes", "--notebooklm-only"]),
    env: { MEMORY_PROVIDER: "hindsight" },
    h: {
      info: (m) => logs.push(m),
      ok: (m) => logs.push(m),
      warn: (m) => logs.push(m),
    },
  });
  check("notebooklm-only dry didNotebooklm", result.didNotebooklm === true);
  check("notebooklm-only dry skipped provider MCP writes", result.didProvider === false);
  check(
    "notebooklm-only dry mentions coding-agent / mcp",
    logs.some((l) => /notebooklmAccess|mcp\.json/i.test(l)),
  );
  check(
    "notebooklm-only dry does not create coding-agent.json",
    !fs.existsSync(path.join(home, ".hindsight/coding-agent.json")),
  );
}

// --- hindsight provider-only message ---
{
  const home = tmp("hs");
  const logs = [];
  const result = await runInstallMemoryMcp({
    home,
    repoRoot: ROOT,
    stackRoot: home,
    flags: parseInstallMcpArgs(["--yes", "--provider-only"]),
    env: { MEMORY_PROVIDER: "hindsight" },
    h: {
      info: (m) => logs.push(m),
      ok: (m) => logs.push(m),
      warn: (m) => logs.push(m),
    },
  });
  check("hindsight provider-only", result.provider === "hindsight" && result.didProvider);
  check(
    "hindsight mentions coding-agents plugin separate",
    logs.some((l) => /coding-agents|personal-memory setup/i.test(l)),
  );
  const mcpPath = path.join(home, ".cursor/mcp.json");
  check("hindsight provider-only still merges unified MCP", fs.existsSync(mcpPath));
  if (fs.existsSync(mcpPath)) {
    const mcp = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
    check("unified personal-memory server present", Boolean(mcp.mcpServers?.["personal-memory"]));
    check("no mem0 server on hindsight", !mcp.mcpServers?.mem0);
  }
}

// --- live mem0 merge (yes, no dry) ---
{
  const home = tmp("mem0-live");
  const stack = tmp("mem0-stack");
  fs.mkdirSync(path.join(home, ".config/hindsight"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config/hindsight/wizard.conf"), "MEMORY_PROVIDER=mem0\n");
  fs.writeFileSync(path.join(stack, ".env"), "MEM0_API_URL=http://127.0.0.1:18888\n");
  const mcpPath = path.join(home, ".cursor/mcp.json");
  fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
  fs.writeFileSync(
    mcpPath,
    JSON.stringify({ mcpServers: { hindsight: { command: "keep" }, codegraph: { command: "cg" } } }),
  );
  await runInstallMemoryMcp({
    home,
    repoRoot: ROOT,
    stackRoot: stack,
    flags: parseInstallMcpArgs(["--yes", "--provider-only"]),
    env: {},
    h: { info: () => {}, ok: () => {}, warn: () => {} },
  });
  const written = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
  check(
    "live mem0 writes node launcher",
    written.mcpServers.mem0?.command === "node" &&
      String(written.mcpServers.mem0?.args?.[0] || "").endsWith("cli/mem0-mcp.mjs"),
  );
  check("live mem0 keeps hindsight", written.mcpServers.hindsight.command === "keep");
  check("live mem0 keeps codegraph", written.mcpServers.codegraph.command === "cg");
  check(
    "live mem0 env has URL (+ BASE_URL)",
    written.mcpServers.mem0.env.MEM0_API_URL === "http://127.0.0.1:18888" &&
      written.mcpServers.mem0.env.MEM0_BASE_URL === "http://127.0.0.1:18888",
  );
  check("live mem0 has no key in mcp.json", !("MEM0_API_KEY" in (written.mcpServers.mem0.env || {})));
  check(
    "live mem0 env file path only",
    String(written.mcpServers.mem0.env.MEM0_ENV_FILE || "").endsWith("mem0.env"),
  );
  const raw = fs.readFileSync(mcpPath, "utf8");
  check("live mem0 file has no secret-looking key assignment", !/MEM0_API_KEY\s*=/.test(raw));
}

// --- cognee warns when script missing; does not write ---
{
  const home = tmp("cognee-missing");
  const fakeRoot = tmp("cognee-pkg");
  fs.mkdirSync(path.join(fakeRoot, "cli"), { recursive: true });
  fs.writeFileSync(path.join(fakeRoot, "cli/personal-memory-mcp.mjs"), "// stub\n");
  // no cognee-mcp.mjs
  const logs = [];
  await runInstallMemoryMcp({
    home,
    repoRoot: fakeRoot,
    stackRoot: fakeRoot,
    flags: parseInstallMcpArgs(["--yes", "--provider-only"]),
    env: { MEMORY_PROVIDER: "cognee" },
    h: {
      info: (m) => logs.push(m),
      ok: (m) => logs.push(m),
      warn: (m) => logs.push(m),
    },
  });
  const mcpPath = path.join(home, ".cursor/mcp.json");
  check("cognee missing script still merges unified MCP", fs.existsSync(mcpPath));
  if (fs.existsSync(mcpPath)) {
    const mcp = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
    check("no cognee server when script missing", !mcp.mcpServers?.cognee);
    check("unified present when cognee script missing", Boolean(mcp.mcpServers?.["personal-memory"]));
  }
  check(
    "cognee warns missing script",
    logs.some((l) => /missing/i.test(l)),
  );
}

// --- cognee live merge when script present ---
{
  const home = tmp("cognee-live");
  fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
  const mcpPath = path.join(home, ".cursor/mcp.json");
  fs.writeFileSync(
    mcpPath,
    JSON.stringify({
      mcpServers: {
        hindsight: { command: "keep" },
        codegraph: { command: "cg" },
        notebooklm: { command: "node", args: ["/n.js"] },
        mem0: { command: "uvx", args: ["keep-mem0"] },
      },
    }),
  );
  await runInstallMemoryMcp({
    home,
    repoRoot: ROOT,
    stackRoot: home,
    flags: parseInstallMcpArgs(["--yes", "--provider-only"]),
    env: { MEMORY_PROVIDER: "cognee", COGNEE_PORT: "18766" },
    h: { info: () => {}, ok: () => {}, warn: () => {} },
  });
  const written = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
  check(
    "live cognee writes MCP",
    written.mcpServers.cognee?.args?.[0]?.endsWith("cli/cognee-mcp.mjs"),
  );
  check(
    "live cognee COGNEE_API_URL from port",
    written.mcpServers.cognee.env?.COGNEE_API_URL === "http://127.0.0.1:18766",
  );
  check("live cognee keeps hindsight", written.mcpServers.hindsight.command === "keep");
  check("live cognee keeps mem0", written.mcpServers.mem0.args?.[0] === "keep-mem0");
  check("live cognee has no API key", !("COGNEE_API_KEY" in (written.mcpServers.cognee.env || {})));
}

// --- idempotent second install-mcp (--yes) ---
{
  const home = tmp("idem");
  const stack = tmp("idem-stack");
  fs.mkdirSync(path.join(home, ".config/hindsight"), { recursive: true });
  fs.writeFileSync(path.join(stack, ".env"), "MEM0_API_URL=http://127.0.0.1:18888\n");
  const mcpPath = path.join(home, ".cursor/mcp.json");
  fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
  fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: {} }));
  const flags = parseInstallMcpArgs(["--yes"]);
  const h = { info: () => {}, ok: () => {}, warn: () => {} };
  await runInstallMemoryMcp({ home, repoRoot: ROOT, stackRoot: stack, flags, env: { MEMORY_PROVIDER: "mem0" }, h });
  const afterFirst = fs.readFileSync(mcpPath, "utf8");
  await runInstallMemoryMcp({ home, repoRoot: ROOT, stackRoot: stack, flags, env: { MEMORY_PROVIDER: "mem0" }, h });
  const afterSecond = fs.readFileSync(mcpPath, "utf8");
  check("install-mcp idempotent json", afterFirst === afterSecond);
}

// --- mutual exclusion ---
{
  let threw = false;
  try {
    await runInstallMemoryMcp({
      home: tmp("mutex"),
      repoRoot: ROOT,
      stackRoot: ROOT,
      flags: parseInstallMcpArgs(["--yes", "--notebooklm-only", "--provider-only"]),
      env: {},
      h: { info: () => {}, ok: () => {}, warn: () => {} },
    });
  } catch {
    threw = true;
  }
  check("notebooklm-only + provider-only throws", threw);
}

if (failed) {
  console.error(`${failed} install-memory-mcp test(s) failed`);
  process.exit(1);
}
console.log("all install-memory-mcp tests passed");
