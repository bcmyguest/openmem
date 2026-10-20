#!/usr/bin/env node
/**
 * Unit tests for cli/switch-memory-provider.mjs: arg parsing, same-provider no-op,
 * dry-run does not write wizard.conf, rejects unknown id.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseSwitchProviderArgs,
  runSwitchMemoryProvider,
  selectableProviderIds,
} from "../../cli/switch-memory-provider.mjs";

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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `pm-switch-prov-${label}-`));
  tmpRoots.push(d);
  return d;
}
process.on("exit", () => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});

const silent = {
  info: () => {},
  ok: () => {},
  warn: () => {},
};

// --- arg parsing ---
{
  const a = parseSwitchProviderArgs(["mem0", "--yes", "--dry-run"]);
  check("parse provider + --yes --dry-run", a.provider === "mem0" && a.yes && a.dry);
  check("parse defaults off", a.noStack === false && a.noMcp === false && a.help === false);

  const b = parseSwitchProviderArgs(["cognee", "--no-stack", "--no-mcp", "-y"]);
  check("parse --no-stack --no-mcp -y", b.provider === "cognee" && b.noStack && b.noMcp && b.yes);

  const c = parseSwitchProviderArgs(["--help"]);
  check("parse --help without provider", c.help && !c.provider);

  const d = parseSwitchProviderArgs(["hindsight", "--bogus", "extra"]);
  check("parse collects unknown", d.unknown.join(",") === "--bogus,extra" && d.provider === "hindsight");
}

// --- selectable ids include known providers ---
{
  const ids = selectableProviderIds();
  check("selectable includes hindsight", ids.includes("hindsight"));
  check("selectable includes mem0", ids.includes("mem0"));
  check("selectable includes cognee", ids.includes("cognee"));
}

// --- same provider: no-op, exit path without writing ---
{
  const home = tmp("same");
  fs.mkdirSync(path.join(home, ".config/hindsight"), { recursive: true });
  const conf = path.join(home, ".config/hindsight/wizard.conf");
  fs.writeFileSync(conf, "MEMORY_PROVIDER=hindsight\nNOTEBOOKLM_HOME=/tmp/nlm\n");
  const before = fs.readFileSync(conf, "utf8");
  const stack = tmp("stack-same");

  const result = await runSwitchMemoryProvider({
    home,
    repoRoot: ROOT,
    stackRoot: stack,
    flags: parseSwitchProviderArgs(["hindsight", "--yes"]),
    env: {},
    h: silent,
  });
  check("same-provider returns same:true", result.same === true && result.aborted === false);
  check("same-provider leaves wizard.conf untouched", fs.readFileSync(conf, "utf8") === before);
}

// --- dry-run does not write wizard.conf ---
{
  const home = tmp("dry");
  fs.mkdirSync(path.join(home, ".config/hindsight"), { recursive: true });
  const conf = path.join(home, ".config/hindsight/wizard.conf");
  fs.writeFileSync(conf, "MEMORY_PROVIDER=hindsight\n");
  const stack = tmp("stack-dry");
  fs.writeFileSync(path.join(stack, ".env"), "MEM0_API_URL=http://127.0.0.1:18888\n");

  await runSwitchMemoryProvider({
    home,
    repoRoot: ROOT,
    stackRoot: stack,
    flags: parseSwitchProviderArgs(["mem0", "--yes", "--dry-run", "--no-stack", "--no-mcp"]),
    env: {},
    h: silent,
  });
  check(
    "dry-run does not change wizard.conf",
    fs.readFileSync(conf, "utf8") === "MEMORY_PROVIDER=hindsight\n",
  );
}

// --- rejects unknown id ---
{
  const home = tmp("bad");
  const stack = tmp("stack-bad");
  let errMsg = "";
  try {
    await runSwitchMemoryProvider({
      home,
      repoRoot: ROOT,
      stackRoot: stack,
      flags: parseSwitchProviderArgs(["not-a-provider", "--yes"]),
      env: {},
      h: silent,
    });
  } catch (e) {
    errMsg = e instanceof Error ? e.message : String(e);
  }
  check("rejects unknown provider id", /unknown|non-selectable/.test(errMsg), errMsg);
}

// --- real switch with --no-stack --no-mcp writes wizard.conf ---
{
  const home = tmp("write");
  fs.mkdirSync(path.join(home, ".config/hindsight"), { recursive: true });
  const conf = path.join(home, ".config/hindsight/wizard.conf");
  fs.writeFileSync(conf, "MEMORY_PROVIDER=hindsight\nNOTEBOOKLM_HOME=/tmp/keep\n");
  const stack = tmp("stack-write");

  await runSwitchMemoryProvider({
    home,
    repoRoot: ROOT,
    stackRoot: stack,
    flags: parseSwitchProviderArgs(["cognee", "--yes", "--no-stack", "--no-mcp"]),
    env: {},
    h: silent,
  });
  const body = fs.readFileSync(conf, "utf8");
  check("switch writes MEMORY_PROVIDER=cognee", /^MEMORY_PROVIDER=cognee$/m.test(body));
  check("switch preserves other wizard.conf keys", /^NOTEBOOKLM_HOME=\/tmp\/keep$/m.test(body));
}

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log("\nall ok");
