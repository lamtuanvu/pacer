import { executorLabel, taskStatus } from "../../../src/view-model/words";
import type { Account } from "./accounts";
import type { LinkSnapshot, TaskData } from "../../../src/link/envelope";
import type { TaskResult } from "../../../src/tasks/types";
import { needsYou, counts as snapshotCounts } from "../../../src/view-model/selectors";
export type TaskTab = "running" | "review" | "history";
export interface TaskSummary {
  task_id: string; goal?: string; state: string; kind: string | null; requested_executor: string | null;
  attempts: { executor: string; exit_code?: number; limit_hit?: boolean; timed_out?: boolean; log?: string }[];
  result: TaskResult | null; review: { accepted: boolean; note?: string | null; kind?: string | null; at?: number } | null;
  reviewRequest?: TaskData["reviewRequest"]; acceptanceState?: TaskData["acceptanceState"];
  resolved: string | null; placement?: { mode?: string; why?: string } | null;
}
export const kinds = ["boilerplate", "tests", "docs", "rename", "migration", "feature", "debug", "refactor", "performance", "unfamiliar-code", "research"];
export const taskHref = (id: string) => `#/tasks/${encodeURIComponent(id)}`;
/** A queued snapshot must not regress a task already running or complete. */
export function mergeTask(task: TaskSummary, live?: TaskData): TaskSummary {
  return {...task, ...(live ? {state: (live.state === "queued" && task.state === "running") || (activeTask(live.state) && !activeTask(task.state)) ? task.state : live.state, reviewRequest: live.reviewRequest ?? task.reviewRequest, acceptanceState: live.acceptanceState ?? task.acceptanceState, review: live.review ?? task.review, resolved: live.resolved ?? task.resolved, goal: live.goal || task.goal} : {})};
}
export const activeTask = (state: string) => state === "running" || state === "queued";
export const needsReview = (task: { state: string; review?: unknown; resolved?: string | null; dismissed?: boolean; reviewRequest?: unknown }) => !!task.reviewRequest && ["done", "partial"].includes(task.state) && !task.review && !task.resolved && !task.dismissed;
export function taskActions(task: { state: string }): ("stop" | "retry" | "dismiss")[] { return activeTask(task.state) ? ["stop"] : ["retry", "dismiss"]; }
export function tasksModel(tasks: TaskSummary[], liveOrSnapshot: TaskData[] | LinkSnapshot, tab: TaskTab, dismissed: string[] = [], accounts: Account[] = []) {
  const snapshot = Array.isArray(liveOrSnapshot) ? undefined : liveOrSnapshot;
  const live = Array.isArray(liveOrSnapshot) ? liveOrSnapshot : liveOrSnapshot.tasks;
  const reviewIds = snapshot?.attention === undefined ? undefined : new Set(needsYou(snapshot, {repo:null}).filter(item => item.kind === "review").map(item => item.taskId));
  const inReview = (task: TaskSummary) => reviewIds ? reviewIds.has(task.task_id) : needsReview(task);
  return tasks.map(task => {
    const update = live.find(t => t.id === task.task_id);
    const merged = mergeTask(task, update);
    return { ...merged, id: task.task_id, goal: merged.goal || task.task_id, executor: executorLabel(update?.executor ?? task.result?.executor ?? task.attempts.at(-1)?.executor ?? task.requested_executor, accounts), status: taskStatus(merged), actions: taskActions(merged), dismissed: dismissed.includes(task.task_id) || (update?.dismissed ?? false) };
  }).filter(task => !task.dismissed && (tab === "running" ? activeTask(task.state) : tab === "review" ? inReview(task) : !activeTask(task.state) && !inReview(task)));
}
export function nextTaskLimit(limit: number): number | null { return limit >= 200 ? null : Math.min(200, limit + 20); }
export interface DelegateDraft { goal: string; repo: string; base: string; acceptance: string; executor: string; kind: string }
export const blankDelegate: DelegateDraft = { goal: "", repo: "", base: "", acceptance: "", executor: "", kind: "" };
/** Resolve defaults once on open so the user can still change the repository. */
export const initialDelegateDraft = (saved: DelegateDraft, filterRepo: string | null, lastRepo = ""): DelegateDraft => {
  const repo = filterRepo || saved.repo || lastRepo;
  return { ...saved, repo, base: repo === saved.repo ? saved.base : "" };
};
export function delegateRoutingParams(draft: DelegateDraft, current: boolean, goal: string) {
  return {
    ...(draft.kind ? { kind: draft.kind } : {}),
    ...(current && goal ? { goal } : {}),
    ...(current && draft.repo ? { repo: draft.repo } : {}),
  };
}
/**
 * Quick delegate from the UI. A 2.1+ service (it lists repo.list) takes a repo key, a base branch, the source and an
 * idempotency id, so a double click or two windows never delegate twice; an older one needs an absolute path.
 */
export function delegateParams(draft: DelegateDraft, ops: ReadonlySet<string>, requestId: string, knownRepos: string[]) {
  const goal = draft.goal.trim(), repo = draft.repo.trim(), current = ops.has("repo.list");
  if (!goal) throw new Error("Goal is required.");
  if (!repo.startsWith("/") && !(current && knownRepos.includes(repo))) throw new Error("Choose a repository.");
  return {
    goal, repo,
    ...(current && draft.base.trim() ? { base: draft.base.trim() } : {}),
    ...(draft.acceptance.trim() ? { acceptance: draft.acceptance.trim() } : {}),
    ...(draft.executor ? { executor: draft.executor } : {}),
    ...(draft.kind ? { kind: draft.kind } : {}),
    ...(current ? { source: "ui" as const, request_id: requestId } : {}),
  };
}

export function taskCounts(snapshot: LinkSnapshot) {
  const c = snapshotCounts(snapshot);
  return { running: c ? c.running + c.queued : snapshot.tasks.filter(t => activeTask(t.state) && !t.dismissed).length,
    review: c?.review ?? (snapshot.attention === undefined ? snapshot.tasks.filter(needsReview).length : needsYou(snapshot, {repo:null}).filter(i=>i.kind==="review").length) };
}
