/** Hook event names and stdout shapes per coding-agent host. */

export const SHIM_MARKER = "personal-memory/coding-agent/hook-runner.mjs";

export const SHIM_HARNESSES = {
  "claude-code": {
    configStyle: "nested",
    settingsPath: (home) => `${home}/.claude/settings.json`,
    rootKey: "hooks",
    events: {
      sessionStart: { hook: "SessionStart", timeout: 30 },
      prompt: { hook: "UserPromptSubmit", timeout: 30 },
      stop: { hook: "Stop", timeout: 60 },
    },
    parse: {
      sessionStart: (ev) => ({ cwd: ev.cwd, sessionId: ev.session_id }),
      prompt: (ev) => ({ cwd: ev.cwd, sessionId: ev.session_id, prompt: ev.prompt }),
      stop: (ev) => ({ cwd: ev.cwd, sessionId: ev.session_id, transcriptPath: ev.transcript_path }),
    },
    emit: {
      sessionStart: (ctx) => ({
        hookSpecificOutput: { hookEventName: "SessionStart", ...(ctx ? { additionalContext: ctx } : {}) },
      }),
      prompt: (ctx) => ({
        hookSpecificOutput: { hookEventName: "UserPromptSubmit", ...(ctx ? { additionalContext: ctx } : {}) },
      }),
      stop: () => ({}),
    },
  },
  codex: {
    configStyle: "nested",
    settingsPath: (home) => `${home}/.codex/hooks.json`,
    rootKey: "hooks",
    events: {
      sessionStart: { hook: "SessionStart", timeout: 30 },
      prompt: { hook: "UserPromptSubmit", timeout: 30 },
      stop: { hook: "Stop", timeout: 60 },
    },
    parse: {
      sessionStart: (ev) => ({ cwd: ev.cwd, sessionId: ev.session_id }),
      prompt: (ev) => ({ cwd: ev.cwd, sessionId: ev.session_id, prompt: ev.prompt ?? ev.user_prompt }),
      stop: (ev) => ({ cwd: ev.cwd, sessionId: ev.session_id, transcriptPath: ev.transcript_path }),
    },
    emit: {
      sessionStart: (ctx) => ({
        hookSpecificOutput: { hookEventName: "SessionStart", ...(ctx ? { additionalContext: ctx } : {}) },
      }),
      prompt: (ctx) => ({
        hookSpecificOutput: { hookEventName: "UserPromptSubmit", ...(ctx ? { additionalContext: ctx } : {}) },
      }),
      stop: () => ({}),
    },
  },
  "cursor-cli": {
    configStyle: "flat",
    settingsPath: (home) => `${home}/.cursor/hooks.json`,
    rootKey: null,
    events: {
      sessionStart: { hook: "sessionStart", timeout: 30 },
      prompt: { hook: "beforeSubmitPrompt", timeout: 30 },
      stop: { hook: "stop", timeout: 30 },
    },
    parse: {
      sessionStart: (ev) => ({
        cwd: ev.cwd ?? ev.workspace_root ?? ev.workspace_roots?.[0],
        sessionId: ev.conversation_id ?? ev.session_id,
      }),
      prompt: (ev) => ({
        cwd: ev.cwd ?? ev.workspace_root ?? ev.workspace_roots?.[0],
        sessionId: ev.conversation_id ?? ev.session_id,
        prompt: ev.prompt ?? ev.user_prompt,
      }),
      stop: (ev) => ({
        cwd: ev.cwd ?? ev.workspace_root ?? ev.workspace_roots?.[0],
        sessionId: ev.conversation_id ?? ev.session_id,
        transcriptPath: ev.transcript_path,
      }),
    },
    emit: {
      sessionStart: (ctx) => (ctx ? { additional_context: ctx } : {}),
      prompt: (ctx) => ({ continue: true, ...(ctx ? { additional_context: ctx } : {}) }),
      stop: () => ({}),
    },
  },
};

export const SHIM_AGENT_IDS = Object.freeze(Object.keys(SHIM_HARNESSES));
