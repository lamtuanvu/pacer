/** Agent identity for marks on every surface: the app draws the glyph, the TUI and status line use the colour. */
export const AGENT_IDS = ["claude-code", "codex", "cursor", "agy", "byteplus", "local", "opencode", "gemini"] as const;
export type AgentId = (typeof AGENT_IDS)[number];
export type AgentGlyph = "claude" | "openai" | "cursor" | "google" | "bytedance" | "lmstudio" | "opencode" | "gemini";
export interface AgentInfo { name: string; glyph: AgentGlyph | null; color: string | "ink"; tile: "tint" | "page-hairline"; monogram: string }

const AGENTS: Record<AgentId, Omit<AgentInfo, "monogram">> = {
  "claude-code": { name: "Claude", glyph: "claude", color: "#D97757", tile: "tint" },
  codex: { name: "Codex", glyph: "openai", color: "ink", tile: "page-hairline" },
  cursor: { name: "Cursor", glyph: "cursor", color: "ink", tile: "tint" },
  agy: { name: "Antigravity", glyph: "google", color: "#4285F4", tile: "tint" },
  byteplus: { name: "BytePlus", glyph: "bytedance", color: "#3C8CFF", tile: "tint" },
  local: { name: "Local model", glyph: "lmstudio", color: "ink", tile: "tint" },
  opencode: { name: "OpenCode", glyph: "opencode", color: "ink", tile: "tint" },
  gemini: { name: "Gemini", glyph: "gemini", color: "#8E75B2", tile: "tint" },
};
const ALIASES: Record<string, AgentId> = { claude: "claude-code", antigravity: "agy" };

/** The canonical id for an agent name or alias, or null when pacer does not know it. */
export function agentKey(agent: string): AgentId | null {
  if (Object.hasOwn(ALIASES, agent)) return ALIASES[agent]!;
  return (AGENT_IDS as readonly string[]).includes(agent) ? agent as AgentId : null;
}
export function agentInfo(agent: string): AgentInfo {
  const key = agentKey(agent);
  const monogram = agent.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "?";
  return key ? { ...AGENTS[key], monogram } : { name: agent, glyph: null, color: "ink", tile: "tint", monogram };
}
/** The agent part of a runner id such as "codex#team@devbox". */
export const runnerAgent = (id: string): string => id.split("@")[0]!.split("#")[0]!;
