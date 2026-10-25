import type { AccountKind } from "./accounts";

export const AGENTS = ["claude-code", "codex", "cursor", "agy", "opencode"] as const;
export type AgentId = (typeof AGENTS)[number];

export const ACCOUNT_KIND: Record<AgentId, AccountKind> = {
  "claude-code": "claude", codex: "codex", cursor: "cursor", agy: "agy", opencode: "endpoint",
};
export function allowedPair(agent: AgentId, kind: AccountKind): boolean {
  return Object.hasOwn(ACCOUNT_KIND, agent) && ACCOUNT_KIND[agent] === kind;
}
