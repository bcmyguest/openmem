/**
 * OpenMem plugin for OpenCode 2 (https://opencode.ai/v2/docs/build/plugins/server/).
 * Prompt recall and retention on idle. Context trimming is left to OpenCode or a separate tool.
 *
 * The default export is a plain `{ id, setup }` object: `Plugin.define` from @opencode/plugin
 * returns its argument unchanged, and OpenCode 2 reads the default export's id and setup().
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bankFromCwd } from "../bank-from-cwd.mjs";
import { accessAllowed, autoRegisterLocation, readAccessConfig } from "../access-policy.mjs";
import { sessionBanner } from "../hook-runner.mjs";
import { hookRecallBlock, sessionRecall, sessionReflectOrSearch, sessionRetain } from "../session-facade.mjs";
import { resolveMcpContext } from "../../mcp/context.mjs";
import { resolveStackRoot } from "../../stack.mjs";
import { fingerprint, isTurnStart, logFailOpen } from "./messages.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const MAX_SESSIONS = 128;
const MAX_RETAIN_CHARS = 12000;
const RETAIN_TIMEOUT_MS = 10000;
const MAX_RECALLS_PER_SESSION = 64;
// OpenCode 2.2.1 publishes session.execution.succeeded; session.status / session.idle are kept for other releases.
const EVENT_TYPES = ["session.execution.succeeded", "session.status", "session.idle"];

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
  autoRegisterLocation(projectDir, { home, env });
  const accessConfig = readAccessConfig(home);
  const allowed = accessAllowed(projectDir, accessConfig);
  const bank = allowed ? bankFromCwd(projectDir, { home, mapPathToBank: accessConfig.mapPathToBank }) : undefined;
  // Constant for the session, so it never changes the cached system prefix.
  const banner = allowed ? sessionBanner(memory.provider, bank) : "";
  // sessionID -> recall text for the prompt in flight ("" once bound or empty); also gates retention on idle.
  const injections = new Map();
  // sessionID -> Map(fingerprint of a user message -> recall text bound to it).
  const recalls = new Map();
  const seen = new Map();
  const retaining = new Set();

  function remember(map, key, value) {
    map.delete(key);
    map.set(key, value);
    while (map.size > MAX_SESSIONS) map.delete(map.keys().next().value);
  }

  async function onPrompt(event) {
    const prompt = String(event.prompt?.text || "").trim();
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

  function onContext(event) {
    event.system.push({ type: "text", text: banner });
    try {
      bindRecall(event.sessionID, event.messages);
      const decorate = recallDecorator(event.sessionID);
      if (!decorate || !Array.isArray(event.messages)) return;
      const decorated = event.messages.map(decorate);
      if (decorated.some((m, i) => m !== event.messages[i])) event.messages = decorated;
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
    if (["session.execution.succeeded", "session.idle"].includes(event.type)
      || (event.type === "session.status" && data.status?.type === "idle")) {
      await onIdle(data.sessionID);
    }
  }

  // A denied workspace gets no hooks: no memory calls, no banner, nothing retained.
  if (!allowed) return () => {};
  await ctx.session.hook("prompt", onPrompt);
  await ctx.session.hook("context", onContext);
  try {
    // Experimental in 2.2.1: runs when model work ends, before the Session goes idle.
    await ctx.session.hook("experimental.idle", (event) => onIdle(event.sessionID));
  } catch { /* releases without the hook fall back to events */ }
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
