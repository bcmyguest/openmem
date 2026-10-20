#!/usr/bin/env node
/**
 * Unit tests for cli/notebooklm-mcp.mjs + providers/hindsight/lib/notebooklm-mcp-install.mjs.
 * No live Hindsight: mock fetch + temp HOME/config.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bankAllowed,
  callTool,
  filterNotebooklmBanks,
  handleMessage,
  isNotebooklmBank,
  resolveAccess,
} from "../../cli/notebooklm-mcp.mjs";
import {
  mergeNotebooklmMcpServer,
  notebooklmMcpScriptPath,
  installNotebooklmMcp,
} from "../../providers/hindsight/lib/notebooklm-mcp-install.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MCP = path.join(ROOT, "cli/notebooklm-mcp.mjs");

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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `pm-nlm-mcp-${label}-`));
  tmpRoots.push(d);
  return d;
}
process.on("exit", () => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});

// --- pure allowlist ---
{
  check("isNotebooklmBank true", isNotebooklmBank("notebooklm::foo"));
  check("isNotebooklmBank false for coding-agent", !isNotebooklmBank("coding-agent::foo"));
  check("bankAllowed *", bankAllowed("notebooklm::a", ["*"]));
  check("bankAllowed by slug", bankAllowed("notebooklm::sitrep-analysis", ["sitrep-analysis"]));
  check("bankAllowed by full id", bankAllowed("notebooklm::sitrep-analysis", ["notebooklm::sitrep-analysis"]));
  check("bankAllowed rejects other slug", !bankAllowed("notebooklm::other", ["sitrep-analysis"]));
  check("bankAllowed rejects non-notebooklm", !bankAllowed("obsidian::vault", ["*"]));

  const banks = [
    { bank_id: "notebooklm::alpha", fact_count: 3 },
    { bank_id: "notebooklm::beta", fact_count: 9 },
    { bank_id: "coding-agent::repo", fact_count: 1 },
    { bank_id: "obsidian::notes", fact_count: 2 },
  ];
  check(
    "filter * keeps only notebooklm",
    filterNotebooklmBanks(banks, ["*"]).map((b) => b.bank_id).join() === "notebooklm::alpha,notebooklm::beta",
  );
  check(
    "filter allowlist slug",
    filterNotebooklmBanks(banks, ["beta"]).map((b) => b.bank_id).join() === "notebooklm::beta",
  );
}

// --- resolveAccess ---
{
  check("resolveAccess disabled by default", resolveAccess({}).enabled === false);
  check("resolveAccess enabled true", resolveAccess({ notebooklmAccess: { enabled: true } }).enabled === true);
  check("resolveAccess enabled string ignored", resolveAccess({ notebooklmAccess: { enabled: "true" } }).enabled === false);
  check(
    "resolveAccess apiUrl default",
    resolveAccess({}).apiUrl === "http://127.0.0.1:8888",
  );
  check(
    "resolveAccess strips trailing slash",
    resolveAccess({ apiUrl: "http://127.0.0.1:8888/" }).apiUrl === "http://127.0.0.1:8888",
  );
  check(
    "resolveAccess banks default *",
    resolveAccess({ notebooklmAccess: { enabled: true } }).banks.join() === "*",
  );
}

// --- mock fetch tools ---
{
  const sample = {
    banks: [
      { bank_id: "notebooklm::keep-me", fact_count: 12 },
      { bank_id: "notebooklm::skip-me", fact_count: 4 },
      { bank_id: "coding-agent::x", fact_count: 99 },
    ],
  };
  /** @type {typeof fetch} */
  const fetchList = async (url) => {
    check("list hits /v1/default/banks", String(url).endsWith("/v1/default/banks"));
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => sample,
      text: async () => JSON.stringify(sample),
    };
  };
  const access = { enabled: true, banks: ["keep-me"], apiUrl: "http://127.0.0.1:8888" };
  const listed = await callTool(access, "notebooklm_list_banks", {}, fetchList);
  const listedBody = JSON.parse(listed.content[0].text);
  check("list_banks filters allowlist", listedBody.count === 1 && listedBody.banks[0].bank_id === "notebooklm::keep-me");

  /** @type {typeof fetch} */
  const fetchListSearch = async (url, init) => {
    check("list search is GET", !init?.method || init.method === "GET");
    check(
      "list search hits memories/list",
      String(url).includes("notebooklm%3A%3Akeep-me") && String(url).includes("/memories/list?"),
    );
    check("list search encodes q", String(url).includes("q=hello"));
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () =>
        JSON.stringify({
          items: [{ id: "1", type: "world", text: "hit from list" }],
          total: 1,
          limit: 20,
          offset: 0,
        }),
      json: async () => ({ items: [{ text: "hit from list" }], total: 1, limit: 20, offset: 0 }),
    };
  };
  const searched = await callTool(
    access,
    "notebooklm_search",
    { bank_id: "notebooklm::keep-me", query: "hello" },
    fetchListSearch,
  );
  const searchedBody = JSON.parse(searched.content[0].text);
  check(
    "search defaults to list mode",
    searchedBody.mode === "list" &&
      searchedBody.items?.[0]?.text === "hit from list" &&
      !searched.isError,
  );

  /** @type {typeof fetch} */
  const fetchRecall = async (url, init) => {
    check(
      "recall URL encodes bank",
      String(url).includes("notebooklm%3A%3Akeep-me") && String(url).endsWith("/memories/recall"),
    );
    const body = JSON.parse(init.body);
    check("recall POST body", init?.method === "POST" && body.query === "hello");
    check("recall uses low budget by default", body.budget === "low");
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ results: [{ text: "hit" }] }),
      json: async () => ({ results: [{ text: "hit" }] }),
    };
  };
  const recalled = await callTool(
    access,
    "notebooklm_search",
    { bank_id: "notebooklm::keep-me", query: "hello", mode: "recall" },
    fetchRecall,
  );
  check("search mode=recall returns recall JSON", /"hit"/.test(recalled.content[0].text) && !recalled.isError);

  const denied = await callTool(
    access,
    "notebooklm_search",
    { bank_id: "notebooklm::skip-me", query: "x" },
    fetchListSearch,
  );
  check("search rejects non-allowlisted bank", denied.isError === true && /allowlisted/.test(denied.content[0].text));

  const codingDenied = await callTool(
    access,
    "notebooklm_search",
    { bank_id: "coding-agent::x", query: "x" },
    async () => {
      throw new Error("should not fetch");
    },
  );
  check("search rejects coding-agent bank", codingDenied.isError === true);
}

// --- JSON-RPC handlers ---
{
  const access = { enabled: true, banks: ["*"], apiUrl: "http://example.test" };
  const init = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, access);
  check("initialize returns serverInfo", init?.result?.serverInfo?.name === "notebooklm");
  const tools = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, access);
  const names = (tools?.result?.tools || []).map((t) => t.name).sort().join(",");
  check("tools/list has both tools", names === "notebooklm_list_banks,notebooklm_search");
  const note = await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, access);
  check("initialized notification has no response", note === null);
}

// --- disabled mode stays alive (Cursor must not see Connection closed) ---
{
  const home = tmp("disabled");
  const cfgPath = path.join(home, "coding-agent.json");
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({ apiUrl: "http://127.0.0.1:8888", notebooklmAccess: { enabled: false, banks: ["*"] } }),
  );
  const child = spawn(process.execPath, [MCP], {
    env: { ...process.env, HINDSIGHT_CODING_AGENT_JSON: cfgPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => {
    stderr += c;
  });
  const line = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    // Cursor Agent uses NDJSON + 2025-11-25; reply must be NDJSON echoing that version.
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } },
  });
  child.stdin.write(`${line}\n`);
  const got = await new Promise((resolve) => {
    let buf = "";
    const t = setTimeout(() => resolve(null), 3000);
    child.stdout.on("data", (c) => {
      buf += c;
      if (buf.includes("notebooklm") && buf.includes("\n")) {
        clearTimeout(t);
        resolve(buf);
      }
    });
  });
  child.kill();
  check("disabled mode stays up for initialize", !!got && /notebooklm/.test(got));
  check("disabled mode replies NDJSON not Content-Length", !!got && got.trimStart().startsWith("{") && !got.includes("Content-Length:"));
  check("disabled mode echoes client protocolVersion", !!got && /"protocolVersion"\s*:\s*"2025-11-25"/.test(got));
  check("disabled mode stderr mentions enabled", /notebooklmAccess\.enabled/i.test(stderr));
}

// --- mcp.json merge ---
{
  const script = notebooklmMcpScriptPath(ROOT);
  check("script path points at cli/notebooklm-mcp.mjs", script.endsWith("cli/notebooklm-mcp.mjs") && fs.existsSync(script));

  const base = {
    mcpServers: {
      codegraph: { command: "codegraph", args: ["serve"] },
      hindsight: { command: "node", args: ["/old/hindsight.js"] },
    },
  };
  const { mcp, changed } = mergeNotebooklmMcpServer(base, script);
  check(
    "merge adds notebooklm",
    changed &&
      mcp.mcpServers.notebooklm.command === process.execPath &&
      mcp.mcpServers.notebooklm.args[0] === script &&
      mcp.mcpServers.notebooklm.type === "stdio",
  );
  check("merge keeps hindsight", mcp.mcpServers.hindsight === base.mcpServers.hindsight);
  check("merge keeps codegraph", mcp.mcpServers.codegraph === base.mcpServers.codegraph);

  const again = mergeNotebooklmMcpServer(mcp, script);
  check("merge is idempotent", again.changed === false);

  const home = tmp("install");
  const agentJson = path.join(home, ".hindsight", "coding-agent.json");
  fs.mkdirSync(path.dirname(agentJson), { recursive: true });
  fs.writeFileSync(
    agentJson,
    JSON.stringify({
      apiUrl: "http://127.0.0.1:8888",
      notebooklmAccess: { enabled: true, banks: ["*"] },
    }),
  );
  const mcpPath = path.join(home, ".cursor", "mcp.json");
  fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
  fs.writeFileSync(mcpPath, JSON.stringify(base, null, 2));

  const logs = [];
  const h = {
    ok: (m) => logs.push(`ok:${m}`),
    info: (m) => logs.push(`info:${m}`),
    warn: (m) => logs.push(`warn:${m}`),
  };
  await installNotebooklmMcp({ home, repoRoot: ROOT, agentJson, dry: false }, h);
  const written = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
  check("install writes notebooklm server", written.mcpServers.notebooklm.args[0] === script);
  check("install preserves hindsight args", written.mcpServers.hindsight.args[0] === "/old/hindsight.js");

  await installNotebooklmMcp({ home, repoRoot: ROOT, agentJson, dry: true }, h);
  check("dry-run does not break existing file", fs.existsSync(mcpPath));

  // disabled: no write when starting from empty
  const home2 = tmp("skip");
  const agent2 = path.join(home2, ".hindsight", "coding-agent.json");
  fs.mkdirSync(path.dirname(agent2), { recursive: true });
  fs.writeFileSync(agent2, JSON.stringify({ notebooklmAccess: { enabled: false } }));
  const logs2 = [];
  await installNotebooklmMcp(
    { home: home2, repoRoot: ROOT, agentJson: agent2, dry: false },
    { ok: (m) => logs2.push(m), info: (m) => logs2.push(m), warn: (m) => logs2.push(m) },
  );
  check(
    "disabled skips mcp.json create",
    !fs.existsSync(path.join(home2, ".cursor", "mcp.json")) && logs2.some((l) => /skip/i.test(l)),
  );
}

if (failed) {
  console.error(`${failed} notebooklm mcp test(s) failed`);
  process.exit(1);
}
console.log("all notebooklm mcp tests passed");
