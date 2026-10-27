#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMcpContext, resolveHindsightApiUrl } from "../../cli/mcp/context.mjs";
import { callUnifiedTool, handleUnifiedMessage } from "../../cli/mcp/memory-facade.mjs";
import { unifiedMcpEntry, installUnifiedMcp } from "../../cli/mcp/unified-mcp-install.mjs";

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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `pm-unified-mcp-${label}-`));
  tmpRoots.push(d);
  return d;
}
process.on("exit", () => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});

{
  check(
    "resolveHindsightApiUrl default",
    resolveHindsightApiUrl({ home: "/h", stackRoot: "/s", env: {} }) === "http://127.0.0.1:8888",
  );
  const home = tmp("ctx");
  const stackRoot = path.join(home, "stack");
  fs.mkdirSync(stackRoot, { recursive: true });
  fs.writeFileSync(path.join(stackRoot, ".env"), "HINDSIGHT_PORT=9999\n");
  fs.mkdirSync(path.join(home, ".config/hindsight"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config/hindsight/wizard.conf"), "MEMORY_PROVIDER=hindsight\n");
  const ctx = resolveMcpContext({ home, stackRoot, repoRoot: ROOT, env: {} });
  check("context provider hindsight", ctx.provider === "hindsight");
  check("context hindsight port from stack", ctx.hindsightUrl === "http://127.0.0.1:9999");
}

{
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      async text() {
        return JSON.stringify({ ok: true, url });
      },
    };
  };
  const ctx = { provider: "hindsight", hindsightUrl: "http://127.0.0.1:8888" };
  await callUnifiedTool(ctx, "memory_add", { content: "hello" }, fetchFn);
  check("hindsight memory_add POST", calls[0]?.url?.includes("/banks/openmem-mcp/memories"));
  await callUnifiedTool(ctx, "memory_recall", { query: "hi" }, fetchFn);
  check("hindsight recall POST", calls[1]?.url?.includes("/memories/recall"));
}

{
  /** @type {typeof fetch} */
  const fetchFn = async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/default/banks")) {
      return { ok: true, async json() { return { banks: [] }; }, async text() { return '{"banks":[]}'; } };
    }
    return { ok: true, async text() { return '{"items":[],"total":0}'; } };
  };
  const r = await callUnifiedTool(
    { provider: "hindsight", hindsightUrl: "http://127.0.0.1:8888" },
    "memory_export",
    {},
    fetchFn,
  );
  const text = r.content[0].text;
  check("memory_export PMM", text.includes("pmm_version"));
}

{
  const msg = await handleUnifiedMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { provider: "hindsight", hindsightUrl: "http://127.0.0.1:8888" },
  );
  check("tools/list includes memory_add", msg.result.tools.some((t) => t.name === "memory_add"));
}

{
  const home = tmp("install");
  const h = { ok: () => {}, info: () => {} };
  installUnifiedMcp(
    { home, repoRoot: ROOT, stackRoot: "/stack", provider: "hindsight", dry: false },
    h,
  );
  const mcp = JSON.parse(fs.readFileSync(path.join(home, ".cursor/mcp.json"), "utf8"));
  check("install writes openmem server", Boolean(mcp.mcpServers?.["openmem"]));
  const entry = unifiedMcpEntry({ provider: "mem0", scriptPath: "/x/openmem-mcp.mjs", stackRoot: "/s" });
  check("entry sets MEMORY_PROVIDER", entry.env.MEMORY_PROVIDER === "mem0");
}

if (failed) process.exit(1);
console.log("all openmem MCP tests passed");
