import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bankFromCwd } from "./bank-from-cwd.mjs";
import { accessAllowed, readAccessConfig } from "./access-policy.mjs";
import { isSmartCompactPrompt, registerSession, writeForceFlag } from "./context-store.mjs";
import { sessionBanner } from "./hook-runner.mjs";
import { sessionRecall, sessionReflectOrSearch, sessionRetain } from "./session-facade.mjs";
import { resolveMcpContext } from "../mcp/context.mjs";
import { resolveStackRoot } from "../stack.mjs";
import { contextProxyFromPmConfig, loadPmConfig } from "../../wizard/lib/pm-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MAX_SESSIONS = 128;
const MAX_RETAIN_CHARS = 12000;

function messageText(item) {
  return (item.parts || []).filter((part) => part.type === "text" && part.text).map((part) => part.text).join("\n");
}

/** `[context_proxy] enabled` in config.toml; false when the file is missing or unreadable. */
function contextProxyEnabled(home, stackRoot) {
  try {
    return contextProxyFromPmConfig(loadPmConfig(home, stackRoot).merged).enabled;
  } catch {
    return false;
  }
}

/** OpenCode v1 local plugin: prompt recall, system context, and per-turn retention. */
export const PersonalMemoryPlugin = async ({ client, directory, worktree }) => {
  const home = process.env.HOME || os.homedir();
  let stackRoot;
  try {
    stackRoot = JSON.parse(fs.readFileSync(path.join(ROOT, "agent-runtime.json"), "utf8")).stackRoot;
  } catch {
    // A checkout uses its ordinary stack resolution.
  }
  const env = { ...process.env, PM_STACK_ROOT: process.env.PM_STACK_ROOT || stackRoot };
  const stack = resolveStackRoot({ pkgRoot: ROOT, home, env });
  const ctx = resolveMcpContext({ home, stackRoot: stack.root, repoRoot: ROOT, env });
  const projectDir = worktree && path.parse(worktree).root !== worktree ? worktree : directory;
  const accessConfig = readAccessConfig(home);
  const allowed = accessAllowed(projectDir, accessConfig);
  // `/smart-compact` sets the context proxy's trim flag whether or not memory is allowed.
  const flagSmartCompact = (input, output) => {
    if (!isSmartCompactPrompt(messageText(output))) return false;
    try { writeForceFlag({ home, env: process.env, sessionId: input.sessionID }); } catch { /* best effort */ }
    return true;
  };
  // The context proxy keys trims by session; OpenCode requests carry no session id of their own.
  // Read once per load: enabling or disabling the proxy takes an OpenCode restart.
  const proxied = contextProxyEnabled(home, stack.root);
  const sessionHeader = async (input, output) => {
    if (proxied && input.sessionID) output.headers["x-openmem-session-id"] = input.sessionID;
  };
  if (!allowed) {
    return {
      "chat.headers": sessionHeader,
      "chat.message": async (input, output) => { flagSmartCompact(input, output); },
      "experimental.chat.system.transform": async () => {},
      event: async () => {},
    };
  }
  const bank = bankFromCwd(projectDir, { home, mapPathToBank: accessConfig.mapPathToBank });
  // Constant for the session, so it never changes the cached system prefix.
  const banner = sessionBanner(ctx.provider, bank);
  const injections = new Map();
  const seen = new Map();

  function remember(sessionID, messageID) {
    seen.delete(sessionID);
    seen.set(sessionID, messageID);
    while (seen.size > MAX_SESSIONS) seen.delete(seen.keys().next().value);
  }

  return {
    "chat.headers": sessionHeader,
    "chat.message": async (input, output) => {
      if (flagSmartCompact(input, output)) return;
      const prompt = messageText(output).trim();
      if (!prompt) return;
      injections.delete(input.sessionID);
      injections.set(input.sessionID, "");
      while (injections.size > MAX_SESSIONS) injections.delete(injections.keys().next().value);
      try {
        const query = prompt.slice(0, 2000);
        const context = seen.has(input.sessionID)
          ? await sessionRecall(ctx, { query, bank, limit: 8 })
          : await sessionReflectOrSearch(ctx, { query, bank, limit: 12 });
        injections.set(input.sessionID, context);
      } catch { /* Memory availability must not interrupt the prompt. */ }
    },
    "experimental.chat.system.transform": async (input, output) => {
      const context = injections.get(input.sessionID);
      if (context) output.system.push(`Personal memory for ${bank}:\n${context}`);
      output.system.push(banner);
    },
    event: async ({ event }) => {
      if (event.type === "session.created") {
        const id = event.properties?.info?.id;
        try { registerSession({ home, env: process.env, sessionId: id, agent: "opencode", cwd: projectDir, bank }); } catch { /* best effort */ }
        return;
      }
      if (event.type !== "session.idle") return;
      const sessionID = event.properties?.sessionID;
      if (!sessionID || !injections.has(sessionID)) return;
      try {
        const response = await client.session.messages({ path: { id: sessionID } });
        const messages = response.data || [];
        const previous = seen.get(sessionID);
        const lastIndex = previous ? messages.findIndex((item) => item.info?.id === previous) : -1;
        // OpenCode may replace old message IDs when a session is compacted.
        // In that case retain a bounded tail instead of silently losing the
        // whole next turn. A small amount of overlap is preferable to a gap.
        const fresh = previous && lastIndex >= 0 ? messages.slice(lastIndex + 1) : messages;
        const content = fresh.map((item) => {
          const text = messageText(item).trim();
          return text ? `${item.info?.role || "message"}: ${text}` : "";
        }).filter(Boolean).join("\n\n").slice(-MAX_RETAIN_CHARS);
        if (content) await sessionRetain(ctx, { bank, content: `OpenCode session ${sessionID}:\n${content}` });
        const last = messages.at(-1)?.info?.id;
        if (last) remember(sessionID, last);
      } catch {
        // Memory availability must not interrupt OpenCode's session.
      } finally {
        injections.delete(sessionID);
      }
    },
  };
};
