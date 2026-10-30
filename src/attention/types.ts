import type { RepoRef } from "../api/read-model/types";

export type AttentionKind = "question" | "review" | "failed" | "limit" | "stuck" | "account_signin" | "executor_down" | "host_down" | "planner_quota" | "setup" | "update" | "discovery" | "discovery-network" | "message";
export interface Action { label: string; op: string; params: Record<string, unknown>; style?: "primary" | "danger"; confirm?: string }
export interface AttentionItem {
  id: string; kind: AttentionKind; severity: "decide" | "problem" | "blocked";
  repo: RepoRef | null;
  taskId?: string; executor?: string; host?: string; account?: string;
  title: string; detail: string; raisedAt: number; since: number;
  actions: Action[]; notify: "important" | "all"; snoozedUntil?: number;
}
