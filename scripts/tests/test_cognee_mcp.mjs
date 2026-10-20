#!/usr/bin/env node
/**
 * Unit tests for cli/cognee-mcp.mjs + providers/cognee/lib/cognee-mcp-install.mjs.
 * No live Cognee: mock fetch + temp HOME.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  callTool,
  handleMessage,
  resolveBaseUrl,
  authHeaders,
} from "../../cli/cognee-mcp.mjs";
import {
  cogneeMcpEntry,
  cogneeMcpScriptPath,
  installCogneeMcp,
  mergeCogneeMcpServer,
  resolveCogneeApiUrl,
} from "../../providers/cognee/lib/cognee-mcp-install.mjs";

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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `pm-cognee-mcp-${label}-`));
  tmpRoots.push(d);
  return d;
}
process.on("exit", () => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});

// --- resolveBaseUrl ---
{
  check(
    "resolveBaseUrl default port 8766",
    resolveBaseUrl({}) === "http://127.0.0.1:8766",
  );
  check(
    "resolveBaseUrl COGNEE_PORT",
    resolveBaseUrl({ COGNEE_PORT: "19999" }) === "http://127.0.0.1:19999",
  );
  check(
    "resolveBaseUrl COGNEE_API_URL wins",
    resolveBaseUrl({ COGNEE_API_URL: "http://127.0.0.1:1/", COGNEE_PORT: "9" }) ===
      "http://127.0.0.1:1",
  );
  check(
    "resolveBaseUrl COGNEE_URL",
    resolveBaseUrl({ COGNEE_URL: "http://cognee.test:8766" }) === "http://cognee.test:8766",
  );
  check("authHeaders empty without key", Object.keys(authHeaders({})).length === 0);
  check("authHeaders X-Api-Key when set", authHeaders({ COGNEE_API_KEY: "k" })["X-Api-Key"] === "k");
}

// --- resolveCogneeApiUrl (install helper) ---
{
  check(
    "resolveCogneeApiUrl default",
    resolveCogneeApiUrl({ env: {} }) === "http://127.0.0.1:8766",
  );
  const home = tmp("url");
  fs.mkdirSync(path.join(home, ".config/hindsight"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config/hindsight/wizard.conf"), "COGNEE_PORT=18766\n");
  check(
    "resolveCogneeApiUrl from wizard.conf",
    resolveCogneeApiUrl({ home, env: {} }) === "http://127.0.0.1:18766",
  );
}

// --- mock fetch tools ---
{
  const access = { baseUrl: "http://127.0.0.1:8766", env: {} };
  /** @type {typeof fetch} */
  const fetchHealth = async (url, init) => {
    check("health hits /health", String(url).endsWith("/health"));
    check("health no auth by default", !init?.headers?.["X-Api-Key"]);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: "ready", health: "healthy" }),
    };
  };
  const health = await callTool(access, "cognee_health", {}, fetchHealth);
  check("cognee_health returns JSON", /"healthy"/.test(health.content[0].text) && !health.isError);

  /** @type {typeof fetch} */
  const fetchSearch = async (url, init) => {
    check("search URL", String(url).endsWith("/api/v1/search"));
    check("search POST", init?.method === "POST");
    const body = JSON.parse(init.body);
    check("search default GRAPH_COMPLETION", body.searchType === "GRAPH_COMPLETION" && body.query === "codename");
    check("search datasets", body.datasets?.join() === "wizard_smoke");
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ result: "heron" }),
    };
  };
  const searched = await callTool(
    access,
    "cognee_search",
    { query: "codename", datasets: ["wizard_smoke"] },
    fetchSearch,
  );
  check("cognee_search returns result", /"heron"/.test(searched.content[0].text) && !searched.isError);

  const missing = await callTool(access, "cognee_search", {}, async () => {
    throw new Error("should not fetch");
  });
  check("cognee_search requires query", missing.isError === true);

  const withKey = { baseUrl: "http://127.0.0.1:8766", env: { COGNEE_API_KEY: "secret-key" } };
  /** @type {typeof fetch} */
  const fetchAuth = async (_url, init) => {
    check("search sends X-Api-Key from env", init?.headers?.["X-Api-Key"] === "secret-key");
    return { ok: true, status: 200, text: async () => "{}" };
  };
  await callTool(withKey, "cognee_search", { query: "x" }, fetchAuth);
}

// --- JSON-RPC handlers ---
{
  const access = { baseUrl: "http://example.test", env: {} };
  const init = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, access);
  check("initialize returns serverInfo", init?.result?.serverInfo?.name === "cognee");
  const tools = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, access);
  const names = (tools?.result?.tools || []).map((t) => t.name).sort().join(",");
  check("tools/list has health+search", names === "cognee_health,cognee_search");
  const note = await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, access);
  check("initialized notification has no response", note === null);
}

// --- mcp.json merge ---
{
  const script = cogneeMcpScriptPath(ROOT);
  check("script path points at cli/cognee-mcp.mjs", script.endsWith("cli/cognee-mcp.mjs") && fs.existsSync(script));

  const entry = cogneeMcpEntry(script, "http://127.0.0.1:8766");
  check("entry has COGNEE_API_URL", entry.env.COGNEE_API_URL === "http://127.0.0.1:8766");
  check("entry has no API key", !("COGNEE_API_KEY" in (entry.env || {})));

  const base = {
    mcpServers: {
      codegraph: { command: "codegraph", args: ["serve"] },
      hindsight: { command: "node", args: ["/old/hindsight.js"] },
      notebooklm: { command: "node", args: ["/n.js"] },
      mem0: { command: "uvx", args: ["mem0-mcp-selfhosted-placeholder"] },
    },
  };
  const { mcp, changed } = mergeCogneeMcpServer(base, script, "http://127.0.0.1:8766");
  check("merge adds cognee", changed && mcp.mcpServers.cognee.args[0] === script);
  check("merge keeps hindsight", mcp.mcpServers.hindsight === base.mcpServers.hindsight);
  check("merge keeps codegraph", mcp.mcpServers.codegraph === base.mcpServers.codegraph);
  check("merge keeps notebooklm", mcp.mcpServers.notebooklm === base.mcpServers.notebooklm);
  check("merge keeps mem0", mcp.mcpServers.mem0 === base.mcpServers.mem0);

  const again = mergeCogneeMcpServer(mcp, script, "http://127.0.0.1:8766");
  check("merge is idempotent", again.changed === false);

  const home = tmp("install");
  const mcpPath = path.join(home, ".cursor", "mcp.json");
  fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
  fs.writeFileSync(mcpPath, JSON.stringify(base, null, 2));

  const logs = [];
  const h = {
    ok: (m) => logs.push(`ok:${m}`),
    info: (m) => logs.push(`info:${m}`),
    warn: (m) => logs.push(`warn:${m}`),
  };
  await installCogneeMcp(
    { home, repoRoot: ROOT, dry: false, cogneeUrl: "http://127.0.0.1:8766" },
    h,
  );
  const written = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
  check("install writes cognee server", written.mcpServers.cognee.args[0] === script);
  check("install preserves hindsight", written.mcpServers.hindsight.args[0] === "/old/hindsight.js");
  check("install preserves mem0", written.mcpServers.mem0.command === "uvx");
  check(
    "install mcp.json has no API key",
    !JSON.stringify(written).includes("COGNEE_API_KEY") &&
      !JSON.stringify(written).includes("secret"),
  );

  await installCogneeMcp({ home, repoRoot: ROOT, dry: true, cogneeUrl: "http://127.0.0.1:8766" }, h);
  check("dry-run does not break existing file", fs.existsSync(mcpPath));

  const home2 = tmp("missing");
  const logs2 = [];
  await installCogneeMcp(
    { home: home2, repoRoot: tmp("empty-pkg"), dry: false },
    { ok: (m) => logs2.push(m), info: (m) => logs2.push(m), warn: (m) => logs2.push(m) },
  );
  check(
    "missing script skips mcp.json create",
    !fs.existsSync(path.join(home2, ".cursor", "mcp.json")) && logs2.some((l) => /missing/i.test(l)),
  );
}

if (failed) {
  console.error(`${failed} cognee mcp test(s) failed`);
  process.exit(1);
}
console.log("all cognee mcp tests passed");
