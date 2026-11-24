import type { RepoRef } from "../api/read-model/types";

export type AttentionKind = "question" | "review" | "failed" | "limit" | "stuck" | "stalled" | "account_signin" | "executor_down" | "host_down" | "planner_quota" | "setup" | "update" | "discovery" | "discovery-network" | "message" | "orchestrator_failed";
export type AttentionUnblocks = "run" | "branch" | "nothing";
export type RunAttentionPriority = "urgent" | "normal" | "background";
export interface Action { label: string; op: string; params: Record<string, unknown>; style?: "primary" | "danger"; confirm?: string }
/** Run identity on /v3-only workflow attention items (D10). Letter is the stored Phase 6 run letter. */
export interface AttentionRunRef {
  id: string;
  letter: string;
  title: string;
  priority: RunAttentionPriority;
}
export interface AttentionItem {
  id: string; kind: AttentionKind; severity: "decide" | "problem" | "blocked";
  repo: RepoRef | null;
  taskId?: string; executor?: string; host?: string; account?: string;
  title: string; detail: string; raisedAt: number; since: number;
  actions: Action[]; notify: "important" | "all"; snoozedUntil?: number;
  /** Caller participant when a stalled item is waiting on an escalated parent (caller-gone grouping). */
  waitingOn?: string;
  /** Present only on structured run questions (Phase 4). */
  unblocks?: AttentionUnblocks;
  run?: AttentionRunRef;
  question?: Record<string, unknown>;
}
