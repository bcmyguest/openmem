/**
 * OpenMem plugin for OpenCode 2 (https://opencode.ai/v2/docs/build/plugins/server/).
 * Prompt recall, retention on idle, session registration, /smart-compact, and native context
 * trimming in the `context` hook (the context proxy's rules, see context-trim.mjs).
 *
 * The default export is a plain `{ id, setup }` object: `Plugin.define` from @opencode/plugin
 * returns its argument unchanged, and OpenCode 2 reads the default export's id and setup().
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bankFromCwd } from "../bank-from-cwd.mjs";
import { accessAllowed, readAccessConfig } from "../access-policy.mjs";
import { SMART_COMPACT_MARKER, isSmartCompactPrompt, registerSession, writeForceFlag } from "../context-store.mjs";
import { compactionSummary, logFailOpen, trimContext, trimSettings } from "../context-trim.mjs";
import { sessionIngestActive, sessionRecall, sessionReflectOrSearch, sessionRetain } from "../session-facade.mjs";
import { resolveMcpContext } from "../../mcp/context.mjs";
import { resolveStackRoot } from "../../stack.mjs";
import { loadPmConfig } from "../../../wizard/lib/pm-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const MAX_SESSIONS = 128;
const MAX_RETAIN_CHARS = 12000;
const RECALL_LIMIT = 20;
const STATUS_TIMEOUT_MS = 2000;
const RETAIN_TIMEOUT_MS = 10000;
// OpenCode 2.2.1 publishes session.execution.succeeded; session.status / session.idle are kept for other releases.
const EVENT_TYPES = ["session.created", "session.execution.succeeded", "session.status", "session.idle"];
const SMART_COMPACT_BODY = `<!-- ${SMART_COMPACT_MARKER} -->
OpenMem will trim this session's earlier context on the next request. Reply with one short line acknowledging this; do not summarize the conversation. After the trim, use \`smart_compact_search\` with this session's id to look up anything earlier.`;

/** Text of an OpenCode 2 session message (Session.Message.Info) for retention. */
function sessionMessageText(info) {
  if (info?.type === "user") return String(info.text || "");
  if (info?.type === "assistant") {
    return (info.content || []).filter((part) => part?.type === "text" && part.text).map((part) => part.text).join("\n");
  }
  return "";
}

function timedFetch(ms) {
  return (url, init = {}) => globalThis.fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}

/** `[compaction] native` in config.toml; default true. */
function nativeCompactionEnabled(home, stackRoot) {
  try {
    return loadPmConfig(home, stackRoot).merged.compaction?.native !== false;
  } catch {
    return true;
  }
}

async function setup(ctx) {
  const home = process.env.HOME || os.homedir();
  let stackRoot;
  try {
    stackRoot = JSON.parse(fs.readFileSync(path.join(ROOT, "agent-runtime.json"), "utf8")).stackRoot;
  } catch {
    // A checkout uses its ordinary stack resolution.
  }
  const env = { ...process.env, PM_STACK_ROOT: process.env.PM_STACK_ROOT || stackRoot };
  const stack = resolveStackRoot({ pkgRoot: ROOT, home, env });
  const memory = resolveMcpContext({ home, stackRoot: stack.root, repoRoot: ROOT, env });
  const projectDir = ctx.location?.directory;
  const accessConfig = readAccessConfig(home);
  const allowed = accessAllowed(projectDir, accessConfig);
  const bank = allowed ? bankFromCwd(projectDir, { home, mapPathToBank: accessConfig.mapPathToBank }) : undefined;
  const settings = trimSettings(process.env, home);
  const nativeCompaction = nativeCompactionEnabled(home, stack.root);
  const injections = new Map();
  const seen = new Map();
  const retaining = new Set();
  const registered = new Set();

  // Recall for the trim pointer uses the registration's bank, as the proxy does.
  const trimDeps = {
    recall: (recallBank, query, maxChars) => sessionRecall(memory, {
      query, bank: recallBank, limit: RECALL_LIMIT, budget: "low", maxTokens: Math.max(256, Math.floor(maxChars / 4)), maxChars,
    }, timedFetch(settings.recallTimeoutS * 1000)),
    pending: (statusBank) => sessionIngestActive(memory, { bank: statusBank }, timedFetch(STATUS_TIMEOUT_MS)),
  };

  function remember(map, key, value) {
    map.delete(key);
    map.set(key, value);
    while (map.size > MAX_SESSIONS) map.delete(map.keys().next().value);
  }

  // A location's plugins can load after its session exists, so session.created may never arrive:
  // register on the first hook call for each session as well.
  function register(sessionID) {
    if (!allowed || !sessionID || registered.has(sessionID)) return;
    try {
      registerSession({ home, env: process.env, sessionId: sessionID, agent: "opencode", cwd: projectDir, bank });
      registered.add(sessionID);
      while (registered.size > MAX_SESSIONS) registered.delete(registered.values().next().value);
    } catch { /* best effort */ }
  }

  // `/smart-compact` sets the trim flag whether or not memory is allowed.
  function flagSmartCompact(sessionID, text) {
    if (!isSmartCompactPrompt(text)) return false;
    try { writeForceFlag({ home, env: process.env, sessionId: sessionID }); } catch { /* best effort */ }
    return true;
  }

  async function onPrompt(event) {
    register(event.sessionID);
    const text = String(event.prompt?.text || "");
    if (flagSmartCompact(event.sessionID, text) || !allowed) return;
    const prompt = text.trim();
    if (!prompt) return;
    remember(injections, event.sessionID, "");
    try {
      const query = prompt.slice(0, 2000);
      const context = seen.has(event.sessionID)
        ? await sessionRecall(memory, { query, bank, limit: 8 })
        : await sessionReflectOrSearch(memory, { query, bank, limit: 12 });
      injections.set(event.sessionID, context);
    } catch { /* Memory availability must not interrupt the prompt. */ }
  }

  async function onContext(event) {
    register(event.sessionID);
    const context = allowed ? injections.get(event.sessionID) : "";
    if (context) event.system.push({ type: "text", text: `Personal memory for ${bank}:\n${context}` });
    try {
      const messages = await trimContext(event, settings, trimDeps);
      if (messages !== event.messages) event.messages = messages;
    } catch (error) { logFailOpen(error); }
  }

  async function onCompaction(event) {
    if (!nativeCompaction || !settings.enabled) return;
    try {
      const summary = await compactionSummary(event, settings, trimDeps);
      if (summary) event.result = { summary, metadata: { openmem: "native-compaction" } };
    } catch (error) { logFailOpen(error); }
  }

  async function onIdle(sessionID) {
    if (!sessionID || !injections.has(sessionID) || retaining.has(sessionID)) return;
    retaining.add(sessionID);
    try {
      const response = await ctx.session.context({ sessionID });
      const messages = Array.isArray(response) ? response : response?.data || [];
      const previous = seen.get(sessionID);
      const lastIndex = previous ? messages.findIndex((item) => item?.id === previous) : -1;
      // Compaction can replace earlier messages; retain a bounded tail rather than lose the turn.
      const fresh = previous && lastIndex >= 0 ? messages.slice(lastIndex + 1) : messages;
      const content = fresh.map((item) => {
        const text = sessionMessageText(item).trim();
        return text ? `${item.type}: ${text}` : "";
      }).filter(Boolean).join("\n\n").slice(-MAX_RETAIN_CHARS);
      if (content) await sessionRetain(memory, { bank, content: `OpenCode session ${sessionID}:\n${content}` }, timedFetch(RETAIN_TIMEOUT_MS));
      const last = messages.at(-1)?.id;
      if (last) remember(seen, sessionID, last);
    } catch {
      // Memory availability must not interrupt OpenCode's session.
    } finally {
      injections.delete(sessionID);
      retaining.delete(sessionID);
    }
  }

  async function onEvent(event) {
    const data = event?.data || event?.properties || {};
    const where = data.location?.directory;
    if (where && projectDir && path.resolve(where) !== path.resolve(projectDir)) return;
    if (event.type === "session.created") register(data.sessionID);
    else if (["session.execution.succeeded", "session.idle"].includes(event.type)
      || (event.type === "session.status" && data.status?.type === "idle")) {
      if (allowed) await onIdle(data.sessionID);
    }
  }

  await ctx.session.hook("prompt", onPrompt);
  await ctx.session.hook("context", onContext);
  await ctx.session.hook("compaction", onCompaction);
  try {
    // Experimental in 2.2.1: runs when model work ends, before the Session goes idle.
    await ctx.session.hook("experimental.idle", async (event) => { if (allowed) await onIdle(event.sessionID); });
  } catch { /* releases without the hook fall back to events */ }
  if (ctx.command?.transform) {
    await ctx.command.transform((editor) => {
      editor.add({
        name: "smart-compact",
        description: "Trim this session's context on the next request (OpenMem)",
        execute: async ({ sessionID, prompt, delivery }) => {
          flagSmartCompact(sessionID, SMART_COMPACT_BODY);
          await ctx.session.prompt({ ...prompt, sessionID, text: SMART_COMPACT_BODY, delivery });
        },
      });
    });
  }
  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ types: EVENT_TYPES, signal: controller.signal })) {
        onEvent(event).catch(logFailOpen);
      }
    } catch (error) {
      if (!controller.signal.aborted) logFailOpen(error);
    }
  })();
  return () => controller.abort();
}

export default { id: "openmem", setup };
