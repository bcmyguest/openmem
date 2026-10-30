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
import { SMART_COMPACT_BODY, isSmartCompactPrompt, registerSession, writeForceFlag } from "../context-store.mjs";
import {
  addStandingInstruction, compactionSummary, fingerprint, isTurnStart, logFailOpen, promptTokensFromOpenCode, recordPromptUsage,
  trimContext, trimSettings,
} from "../context-trim.mjs";
import { sessionBanner } from "../hook-runner.mjs";
import { hookRecallBlock, sessionIngestActive, sessionRecall, sessionReflectOrSearch, sessionRetain } from "../session-facade.mjs";
import { resolveMcpContext } from "../../mcp/context.mjs";
import { resolveStackRoot } from "../../stack.mjs";
import { contextAgentsFromPmConfig, contextTrimEnvFromPmConfig, contextTrimFromPmConfig, loadPmConfig } from "../../../wizard/lib/pm-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const MAX_SESSIONS = 128;
const MAX_RETAIN_CHARS = 12000;
const RECALL_LIMIT = 20;
const STATUS_TIMEOUT_MS = 2000;
const RETAIN_TIMEOUT_MS = 10000;
const MAX_RECALLS_PER_SESSION = 64;
// Measured context requests per session still waiting for their step's usage.
const MAX_MEASURED_PER_SESSION = 8;
// OpenCode 2.2.1 publishes session.execution.succeeded; session.status / session.idle are kept for other releases.
// session.step.ended carries each model call's TokenUsage, which calibrates the trim estimate.
const EVENT_TYPES = [
  "session.created", "session.execution.succeeded", "session.status", "session.idle",
  "session.step.ended", "session.step.failed", "session.execution.interrupted", "session.execution.failed",
];

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

/** Merged config.toml; empty when it cannot be read, so every setting falls back to its default. */
function readPmConfig(home, stackRoot) {
  try {
    return loadPmConfig(home, stackRoot).merged;
  } catch {
    return {};
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
  // config.toml `[context_proxy]` / `[compaction]` keys, with CONTEXT_* environment variables winning.
  // Trimming follows `[context_proxy.agents] opencode2`, else `[context_proxy] enabled`, else on (no service needed);
  // CONTEXT_PROXY_ENABLED overrides.
  const pmConfig = readPmConfig(home, stack.root);
  const trimOn = contextAgentsFromPmConfig(pmConfig).agents.opencode2;
  const settings = trimSettings({ ...contextTrimEnvFromPmConfig(pmConfig), CONTEXT_PROXY_ENABLED: trimOn ? "1" : "0", ...process.env }, home);
  const nativeCompaction = contextTrimFromPmConfig(pmConfig).compactionNative;
  // Constant for the session, so it never changes the cached system prefix.
  const banner = allowed ? sessionBanner(memory.provider, bank) : "";
  // sessionID -> recall text for the prompt in flight ("" once bound or empty); also gates retention on idle.
  const injections = new Map();
  // sessionID -> Map(fingerprint of a user message -> recall text bound to it).
  const recalls = new Map();
  const seen = new Map();
  const retaining = new Set();
  const registered = new Set();
  // sessionID -> FIFO of { root, chars } from trimContext, one per context request, paired with session.step.ended.
  const measured = new Map();

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
      // Framed once here, so every request renders the bound recall byte for byte.
      injections.set(event.sessionID, hookRecallBlock(context));
    } catch { /* Memory availability must not interrupt the prompt. */ }
  }

  /**
   * Per-prompt recall belongs to the user message that prompted it, never to the system prompt: the
   * first context call after a prompt binds the recall to the newest user message, and every later
   * request renders that message with the same recall part. Older turns keep their bytes, so the
   * request only grows at its end and the prompt-cache prefix stays valid.
   */
  function bindRecall(sessionID, messages) {
    const pending = injections.get(sessionID);
    if (!pending || !Array.isArray(messages)) return;
    const newest = messages.findLast((m) => m && typeof m === "object" && isTurnStart(m));
    if (!newest) return;
    const bound = recalls.get(sessionID) || new Map();
    remember(bound, fingerprint(newest), pending);
    while (bound.size > MAX_RECALLS_PER_SESSION) bound.delete(bound.keys().next().value);
    remember(recalls, sessionID, bound);
    injections.set(sessionID, "");
  }

  function recallDecorator(sessionID) {
    const bound = recalls.get(sessionID);
    if (!bound?.size) return undefined;
    return (message) => {
      if (message?.role !== "user" || !Array.isArray(message.content)) return message;
      const text = bound.get(fingerprint(message));
      if (!text) return message;
      // Trailing blank line: OpenAI-compatible lowering joins text parts with no separator.
      return { ...message, content: [{ type: "text", text: `Personal memory for ${bank}:\n${text}\n\n` }, ...message.content] };
    };
  }

  /** Queue a measured request; steps of one session run in order, so step events pop in the same order. */
  function onMeasured(sessionID, sample) {
    const queue = measured.get(sessionID) || [];
    queue.push(sample);
    while (queue.length > MAX_MEASURED_PER_SESSION) queue.shift();
    remember(measured, sessionID, queue);
  }

  async function onStepEnded(data) {
    const sample = measured.get(data.sessionID)?.shift();
    const tokens = promptTokensFromOpenCode(data.tokens);
    if (sample && tokens) await recordPromptUsage(settings, data.sessionID, sample, tokens);
  }

  async function onContext(event) {
    register(event.sessionID);
    let decorate;
    if (allowed) {
      event.system.push({ type: "text", text: banner });
      try {
        bindRecall(event.sessionID, event.messages);
        decorate = recallDecorator(event.sessionID);
      } catch (error) { logFailOpen(error); }
    }
    const original = event.messages;
    let messages = original;
    try {
      messages = await trimContext(event, settings, { ...trimDeps, decorate, measured: (sample) => onMeasured(event.sessionID, sample) });
    } catch (error) { logFailOpen(error); }
    // trimContext returns its input untouched when trimming is off or the request is malformed.
    if (messages === original && decorate && Array.isArray(original)) {
      const decorated = original.map(decorate);
      if (decorated.some((m, i) => m !== original[i])) messages = decorated;
    }
    if (messages !== original) event.messages = messages;
    // Constant and after the banner, so the system prefix is the same from the first request on; added after
    // the trim so its size never moves the cut (the proxy adds it after trimming too).
    try { addStandingInstruction(event.system, settings); } catch (error) { logFailOpen(error); }
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
    else if (event.type === "session.step.ended") await onStepEnded(data);
    else if (event.type === "session.step.failed") measured.get(data.sessionID)?.shift();
    else if (["session.execution.interrupted", "session.execution.failed"].includes(event.type)) measured.delete(data.sessionID);
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
