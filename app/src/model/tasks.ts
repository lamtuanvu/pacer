import type { Account } from "./accounts";
import type { LinkSnapshot, TaskData } from "../../../src/link/envelope";
import type { TaskResult } from "../../../src/tasks/types";
export type Tone = "good" | "warn" | "bad" | "info" | "neutral";
export type TaskTab = "running" | "review" | "history";
export interface TaskSummary {
  task_id: string; goal?: string; state: string; kind: string | null; requested_executor: string | null;
  attempts: { executor: string; exit_code?: number; limit_hit?: boolean; timed_out?: boolean; log?: string }[];
  result: TaskResult | null; review: { accepted: boolean; note?: string | null; kind?: string | null; at?: number } | null;
  resolved: string | null; placement?: { mode?: string; why?: string } | null;
}
export const kinds = ["boilerplate", "tests", "docs", "rename", "migration", "feature", "debug", "refactor", "performance", "unfamiliar-code", "research"];
export const taskHref = (id: string) => `#/tasks/${encodeURIComponent(id)}`;
/** Public labels shared by every screen; account names distinguish endpoints. */
export function executorLabel(id: string | null | undefined, accounts: Account[] = []): string {
  if (!id) return "Automatic";
  const [local, host] = id.split("@");
  const [agent, name] = local!.split("#");
  const account = accounts.find(a => a.runners?.includes(id) || a.name === name);
  const native = ({"claude-code":"Claude Code",claude:"Claude",codex:"Codex",cursor:"Cursor",agy:"Antigravity",antigravity:"Antigravity"} as Record<string,string>)[agent!];
  const defaultAccount = account?.source === "default" || (account?.folder && (
    (agent === "codex" && account.folder.endsWith("/.codex")) ||
    (agent === "claude-code" && account.folder.endsWith("/.claude"))
  ));
  const suffix = name && !defaultAccount ? ` · ${account?.name ?? name}` : "";
  const label = agent === "opencode" ? `${account?.name ?? name ?? "OpenCode"}` : `${native ?? agent}${suffix}`;
  return label + (host ? ` on ${host}` : "");
}
export function executorCaption(account?: Account): string {
  if (account?.kind !== "endpoint") return "Agent CLI";
  return account.connection?.base_url_host ? `Model endpoint · ${account.connection.base_url_host}` : "External OpenCode provider";
}
/** A queued snapshot must not regress a task already running or complete. */
export function mergeTask(task: TaskSummary, live?: TaskData): TaskSummary {
  return {...task, ...(live ? {state: (live.state === "queued" && task.state === "running") || (activeTask(live.state) && !activeTask(task.state)) ? task.state : live.state, review: live.review ?? task.review, resolved: live.resolved ?? task.resolved, goal: live.goal || task.goal} : {})};
}
export const activeTask = (state: string) => state === "running" || state === "queued";
export const needsReview = (task: { state: string; review?: unknown; resolved?: string | null; dismissed?: boolean }) => ["done", "partial"].includes(task.state) && !task.review && !task.resolved && !task.dismissed;
export function taskStatus(task: { state: string; review?: { accepted: boolean } | null }): { label: string; tone: Tone } {
  if (task.review) return { label: task.review.accepted ? "Accepted" : "Rejected", tone: task.review.accepted ? "good" : "bad" };
  const labels: Record<string, [string, Tone]> = { needs_input: ["Needs your answer", "warn"], running: ["Working", "info"], queued: ["Queued", "neutral"], done: ["Done", "good"], partial: ["Partial", "warn"], failed: ["Failed", "bad"], limit: ["Out of quota", "warn"], stopped: ["Stopped", "neutral"] };
  const [label, tone] = labels[task.state] ?? [task.state, "neutral"];
  return { label, tone };
}
export function taskActions(task: { state: string }): ("stop" | "retry" | "dismiss")[] { return activeTask(task.state) ? ["stop"] : ["retry", "dismiss"]; }
export function tasksModel(tasks: TaskSummary[], liveOrSnapshot: TaskData[] | LinkSnapshot, tab: TaskTab, dismissed: string[] = [], accounts: Account[] = []) {
  const snapshot = Array.isArray(liveOrSnapshot) ? undefined : liveOrSnapshot;
  const live = Array.isArray(liveOrSnapshot) ? liveOrSnapshot : liveOrSnapshot.tasks;
  const reviewIds = snapshot?.attention === undefined ? undefined : new Set(snapshot.attention.filter(item => item.kind === "review").map(item => item.taskId));
  const inReview = (task: TaskSummary) => reviewIds ? reviewIds.has(task.task_id) : needsReview(task);
  return tasks.map(task => {
    const update = live.find(t => t.id === task.task_id);
    const merged = mergeTask(task, update);
    return { ...merged, id: task.task_id, goal: merged.goal || task.task_id, executor: executorLabel(update?.executor ?? task.result?.executor ?? task.attempts.at(-1)?.executor ?? task.requested_executor, accounts), status: taskStatus(merged), actions: taskActions(merged), dismissed: dismissed.includes(task.task_id) || (update?.dismissed ?? false) };
  }).filter(task => !task.dismissed && (tab === "running" ? activeTask(task.state) : tab === "review" ? inReview(task) : !activeTask(task.state) && !inReview(task)));
}
export function nextTaskLimit(limit: number): number | null { return limit >= 200 ? null : Math.min(200, limit + 20); }
export interface DelegateDraft { goal: string; repo: string; kind: string; executor: string; worktree: string; timeout: string; acceptance: string }
export const blankDelegate: DelegateDraft = { goal: "", repo: "", kind: "feature", executor: "", worktree: "auto", timeout: "30", acceptance: "" };
export function delegateParams(draft: DelegateDraft) {
  if (!draft.goal.trim()) throw new Error("Goal is required.");
  if (!draft.repo.trim().startsWith("/")) throw new Error("Repository must be an absolute path.");
  const timeout = Number(draft.timeout);
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 240) throw new Error("Timeout must be between 1 and 240 minutes.");
  if (!kinds.includes(draft.kind)) throw new Error("Choose a task kind.");
  if (!["auto", "new", "current"].includes(draft.worktree)) throw new Error("Choose a worktree mode.");
  return { goal: draft.goal.trim(), repo: draft.repo.trim(), kind: draft.kind, worktree: draft.worktree, timeout_min: timeout, ...(draft.executor ? { executor: draft.executor } : {}), ...(draft.acceptance.trim() ? { acceptance: draft.acceptance.trim() } : {}) };
}
export function recentRepos(paths: string[]): string[] { return [...new Set(paths.filter(Boolean))].slice(0, 10); }

export function taskCounts(snapshot: LinkSnapshot) {
  return { running: snapshot.counts ? snapshot.counts.running + snapshot.counts.queued : snapshot.tasks.filter(t => activeTask(t.state) && !t.dismissed).length, review: snapshot.counts?.review ?? (snapshot.attention?.filter(item => item.kind === "review").length ?? snapshot.tasks.filter(needsReview).length) };
}
