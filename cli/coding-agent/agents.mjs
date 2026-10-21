/** Supported coding-agent targets for install-coding-agent. */

export const CODING_AGENTS = Object.freeze([
  { id: "claude-code", label: "Claude Code", hindsightInstall: true },
  { id: "codex", label: "Codex CLI", hindsightInstall: true },
  { id: "opencode", label: "OpenCode", hindsightInstall: true },
  { id: "cursor-cli", label: "Cursor CLI", hindsightInstall: true },
  {
    id: "hermes",
    label: "Hermes",
    hindsightInstall: false,
    sessionPath: "Unified personal-memory MCP (memory_*) or agent-native MCP; no bundled Hermes plugin in this repo.",
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    hindsightInstall: false,
    sessionPath: "Use install-mcp; configure Gemini MCP per Google docs.",
  },
  {
    id: "amp",
    label: "Amp (Sourcegraph)",
    hindsightInstall: false,
    sessionPath: "Unified MCP via install-mcp; follow Amp MCP configuration.",
  },
  {
    id: "cline",
    label: "Cline",
    hindsightInstall: false,
    sessionPath: "Unified MCP in Cursor/VS Code; install-mcp for memory_* tools.",
  },
]);

export const DEFAULT_AGENT_IDS = CODING_AGENTS.filter((a) => a.hindsightInstall).map((a) => a.id);
