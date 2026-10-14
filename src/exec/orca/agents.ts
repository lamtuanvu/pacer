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
  if (cfg.via === "opencode") {
    // OpenCode model selection requires an existing worktree. Without the model,
    // OpenCode could use a different default provider.
    if (worktree !== "current") {
      return { skip: `Orca can select an OpenCode model only in an existing worktree; ${cfg.id} needs execution.worktree: current to run on Orca` };
    }
    return { agent: "opencode", model: cfg.model };
  }
  const agent = ORCA_AGENTS[parseRunnerId(cfg.id)?.agent ?? cfg.id];
  return agent ? { agent, model: cfg.model } : { skip: `no Orca agent for provider "${cfg.id}"` };
}
