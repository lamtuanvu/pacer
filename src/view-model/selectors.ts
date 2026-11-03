/** Pure selectors over the 2.1 snapshot, shared by every surface. They filter and order what the service derived; they decide nothing. */
import type { AttentionItem, Counts, ExecutorRow, PlannerMeter, RepoRef } from "../api/read-model/types";
import type { ClientSnapshot as SnapshotV2, ClientTask as TaskDataV2 } from "./snapshot";

export interface Scope { repo: string | null }

const memo = new WeakMap<object, Map<string, unknown>>();
function cached<T>(s: SnapshotV2, key: string, build: () => T): T {
  let entries = memo.get(s);
  if (!entries) memo.set(s, entries = new Map());
  if (!entries.has(key)) entries.set(key, build());
  return entries.get(key) as T;
}
const inScope = (scope: Scope, repo: RepoRef | null | undefined) => scope.repo === null || !repo || repo.key === scope.repo;
const active = (state: string) => state === "running" || state === "queued";

const SEVERITY = { blocked: 0, problem: 1, decide: 2 } as const;
/** The ordering rule from the functionality spec: blocked, then problems, then decisions; oldest first within each. */
export const attentionOrder = (a: AttentionItem, b: AttentionItem): number => (SEVERITY[a.severity] ?? 3) - (SEVERITY[b.severity] ?? 3) || a.raisedAt - b.raisedAt;

/** Compatibility for old services that raised a review for every completion. */
function actionableItems(s: SnapshotV2): AttentionItem[] {
 return (s.attention ?? []).flatMap(item => {
  if (item.kind !== "review") return [item];
  const task = s.tasks.find(t => t.id === item.taskId);
  if (!task) return [item]; // Never hide a decision whose result is outside the snapshot.
  if (task.review || task.resolved || task.dismissed || task.retriedBy) return [];
  if (task.state === "partial" || task.acceptanceState === "failed") {
   return [{...item,kind:"failed" as const,severity:"problem" as const,
    detail:task.acceptanceState === "failed" ? "Acceptance checks failed" : "Execution is incomplete",
    actions:[{label:task.acceptanceState === "failed" ? "Inspect failures" : "Inspect incomplete work",op:"ui.open",params:{view:"task",id:task.id}}]}];
  }
  return task.state !== "done" || task.reviewRequest ? [item] : [];
 });
}

/** Items with no repo (hosts, accounts, planner, setup) show in every scope. Snoozes are judged at the snapshot's time. */
export const needsYou = (s: SnapshotV2, scope: Scope): AttentionItem[] => cached(s, `needsYou:${scope.repo}`, () =>
  actionableItems(s).filter(a => !(a.snoozedUntil && a.snoozedUntil > s.at) && (scope.repo === null || !a.repo || a.repo.key === scope.repo)));
export const otherReposNeedingYou = (s: SnapshotV2, scope: Scope): number => scope.repo === null ? 0 :
  needsYou(s, { repo: null }).length - needsYou(s, scope).length;
export const running = (s: SnapshotV2, scope: Scope): TaskDataV2[] => cached(s, `running:${scope.repo}`, () =>
  s.tasks.filter(t => (active(t.state)||!!t.activeAgentSessions) && !t.dismissed && inScope(scope, t.repo)));
export const capacity = (s: SnapshotV2): ExecutorRow[] => s.executors ?? [];
export const doneToday = (s: SnapshotV2, scope: Scope): TaskDataV2[] => cached(s, `doneToday:${scope.repo}`, () => {
  const since = s.today?.since;
  if (since === undefined) return [];
  return s.tasks.filter(t => t.source !== "onboarding" && !active(t.state) && !t.activeAgentSessions && t.updatedAt >= since && inScope(scope, t.repo)).sort((a, b) => b.updatedAt - a.updatedAt);
});
/** The review queue is the review items, newest last. */
export const reviewQueue = (s: SnapshotV2): AttentionItem[] => cached(s, "reviewQueue", () =>
  needsYou(s, {repo:null}).filter(a => a.kind === "review").sort((a, b) => a.raisedAt - b.raisedAt));
export const counts = (s: SnapshotV2): Counts | null => {
 if (!s.counts || s.attention === undefined) return s.counts ?? null;
 const items = needsYou(s, {repo:null});
 const byRepo = Object.fromEntries(Object.entries(s.counts.byRepo).map(([key, value]) => [key, {...value, attention:0, review:0}]));
 for (const item of items) if (item.repo) {
  const c = byRepo[item.repo.key] ??= {running:0,attention:0,review:0};
  c.attention++; if (item.kind === "review") c.review++;
 }
 return {...s.counts,attention:items.length,problems:items.filter(i=>i.severity!=="decide").length,review:items.filter(i=>i.kind==="review").length,byRepo};
};
export const repos = (s: SnapshotV2): RepoRef[] => s.repos ?? [];
export const plannerMeter = (s: SnapshotV2): PlannerMeter | null => s.planner ?? null;
