/** Pure selectors over the 2.1 snapshot, shared by every surface. They filter and order what the service derived; they decide nothing. */
import type { AttentionItem, Counts, ExecutorRow, PlannerMeter, RepoRef, SnapshotV2, TaskDataV2 } from "../api/read-model";

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

/** Items with no repo (hosts, accounts, planner, setup) show in every scope. Snoozes are judged at the snapshot's time. */
export const needsYou = (s: SnapshotV2, scope: Scope): AttentionItem[] => cached(s, `needsYou:${scope.repo}`, () =>
  (s.attention ?? []).filter(a => !(a.snoozedUntil && a.snoozedUntil > s.at) && (scope.repo === null || !a.repo || a.repo.key === scope.repo)));
export const otherReposNeedingYou = (s: SnapshotV2, scope: Scope): number => scope.repo === null ? 0 :
  needsYou(s, { repo: null }).length - needsYou(s, scope).length;
export const running = (s: SnapshotV2, scope: Scope): TaskDataV2[] => cached(s, `running:${scope.repo}`, () =>
  s.tasks.filter(t => active(t.state) && !t.dismissed && inScope(scope, t.repo)));
export const capacity = (s: SnapshotV2): ExecutorRow[] => s.executors ?? [];
export const doneToday = (s: SnapshotV2, scope: Scope): TaskDataV2[] => cached(s, `doneToday:${scope.repo}`, () => {
  const since = s.today?.since;
  if (since === undefined) return [];
  return s.tasks.filter(t => !active(t.state) && t.updatedAt >= since && inScope(scope, t.repo)).sort((a, b) => b.updatedAt - a.updatedAt);
});
/** The review queue is the review items, newest last. */
export const reviewQueue = (s: SnapshotV2): AttentionItem[] => cached(s, "reviewQueue", () =>
  (s.attention ?? []).filter(a => a.kind === "review").sort((a, b) => a.raisedAt - b.raisedAt));
export const counts = (s: SnapshotV2): Counts | null => s.counts ?? null;
export const repos = (s: SnapshotV2): RepoRef[] => s.repos ?? [];
export const plannerMeter = (s: SnapshotV2): PlannerMeter | null => s.planner ?? null;
