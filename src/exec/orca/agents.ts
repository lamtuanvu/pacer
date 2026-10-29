import { parseRunnerId } from "../../config/runner-id";
import type { WorktreeMode } from "../../config/execution";
import type { ProviderCfg } from "../../config/strategy";

/** pacer provider id -> Orca agent id (verified: `orca orchestration worker-start --help`). */
export const ORCA_AGENTS: Readonly<Record<string, string>> = {
  codex: "codex",
  cursor: "cursor",
  "claude-code": "claude",
  agy: "antigravity",
};

export type AgentPick = { agent: string; model: string | null } | { skip: string };

export function orcaAgentFor(cfg: ProviderCfg, worktree: WorktreeMode): AgentPick {
  const selected = parseRunnerId(cfg.id)?.agent ?? cfg.id;
  if (cfg.via === "opencode" || (selected !== "claude-code" && selected !== "codex")) {
    return { skip: `Orca terminal execution is not supported for provider "${cfg.id}"` };
  }
  const agent = ORCA_AGENTS[parseRunnerId(cfg.id)?.agent ?? cfg.id];
  return agent ? { agent, model: cfg.model } : { skip: `no Orca agent for provider "${cfg.id}"` };
}
