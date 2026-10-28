import { z } from "zod";
import { parseRunnerId } from "../config/runner-id";
import { dispatchDatabase } from "../dispatch/store";
import type { Ctx } from "../types";

export const insightsInputSchema = z.object({
  from: z.number().nonnegative(), to: z.number().positive(), repo: z.string().min(1).max(512).optional(), bucket: z.enum(["day", "week"]).default("day"),
}).strict().refine(v => v.to > v.from, "to must be after from").refine(v => v.to - v.from <= 400 * 86400, "period is limited to 400 days");
export type InsightsInput = z.infer<typeof insightsInputSchema>;

/**
 * Fill the first-settle index for history. A task that settled once keeps the record's `settledAt`; a task with several
 * attempts has been settled before, so its first attempt's end is the better estimate. Only adds rows.
 */
export function backfillFirstSettled(ctx: Ctx): number {
  const db = dispatchDatabase(ctx);
  return db.query(`INSERT OR IGNORE INTO task_first_settle(task_id,at)
    SELECT id, CASE WHEN json_array_length(record,'$.attempts')>1 AND json_extract(record,'$.attempts[0].endedAt') IS NOT NULL
        THEN json_extract(record,'$.attempts[0].endedAt') ELSE json_extract(record,'$.settledAt') END
    FROM tasks WHERE json_extract(record,'$.settledAt') IS NOT NULL`).run().changes;
}

interface Row { task_id: string; attempt: number; root_id: string; executor: string; kind: string | null; outcome: string | null; ladder_rule: string | null;
  ended_at: number; coverage: string; total: number | null; input: number | null; output: number | null; cache_read: number | null; cache_write: number | null; skipped: string | null }
const agentOf = (executor: string) => parseRunnerId(executor)?.agent ?? executor;
const BUCKET = { day: 86400, week: 7 * 86400 } as const;

interface Sums { total: number; input: number; output: number; cacheRead: number; cacheWrite: number; measuredAttempts: number; partialAttempts: number; unknownAttempts: number }
const sums = (): Sums => ({ total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, measuredAttempts: 0, partialAttempts: 0, unknownAttempts: 0 });
function addRow(s: Sums, r: Row): void {
  s.total += r.total ?? 0; s.input += r.input ?? 0; s.output += r.output ?? 0; s.cacheRead += r.cache_read ?? 0; s.cacheWrite += r.cache_write ?? 0;
  if (r.coverage === "measured") s.measuredAttempts++; else if (r.coverage === "partial") s.partialAttempts++; else s.unknownAttempts++;
}

/** Core figures for one period; the previous period of equal length is computed the same way for deltas. */
function period(ctx: Ctx, from: number, to: number, repo: string | undefined, bucket: "day" | "week") {
  const db = dispatchDatabase(ctx);
  // Root task: a work node with no parent, or a task with no work node. Handled: its first settle falls in the period.
  const roots = db.query<{ id: string; accepted: number | null; repo: string | null }, [number, number, string, string]>(
    `SELECT t.id, json_extract(t.record,'$.review.accepted') AS accepted FROM tasks t JOIN task_first_settle f ON f.task_id=t.id
     LEFT JOIN work_nodes n ON n.task_id=t.id
     WHERE f.at>=? AND f.at<? AND (n.task_id IS NULL OR n.parent_id IS NULL) AND (?='' OR json_extract(t.record,'$.repo.key')=?)`).all(from, to, repo ?? "", repo ?? "");
  const rootIds = roots.map(r => r.id);
  const inTree = db.query<{ task_id: string; root_id: string; attempts: number }, [string]>(
    `SELECT t.id AS task_id, COALESCE(n.root_id,t.id) AS root_id, json_array_length(t.record,'$.attempts') AS attempts FROM tasks t LEFT JOIN work_nodes n ON n.task_id=t.id WHERE COALESCE(n.root_id,t.id)=?`);
  let subtasks = 0, attemptsInTrees = 0, retryAttempts = 0, acceptedFirstTry = 0, reviewed = 0;
  for (const root of roots) {
    const tasks = inTree.all(root.id);
    subtasks += tasks.filter(t => t.task_id !== root.id).length;
    attemptsInTrees += tasks.reduce((n, t) => n + t.attempts, 0);
    retryAttempts += tasks.reduce((n, t) => n + Math.max(0, t.attempts - 1), 0);
    if (root.accepted !== null) reviewed++;
    // Accepted first try: accepted at review, one attempt per task in its tree, no retries anywhere.
    if (root.accepted === 1 && tasks.every(t => t.attempts <= 1)) acceptedFirstTry++;
  }
  // Token spend: attempts that ended in the period.
  const rows = db.query<Row, [number, number, string, string]>(
    `SELECT u.task_id,u.attempt,u.root_id,u.executor,u.kind,u.outcome,u.ladder_rule,u.ended_at,u.coverage,u.total,u.input,u.output,u.cache_read,u.cache_write,
       json_extract(t.record,'$.attempts['||(u.attempt-1)||'].routing.skipped') AS skipped
     FROM attempt_usage u LEFT JOIN tasks t ON t.id=u.task_id WHERE u.ended_at>=? AND u.ended_at<? AND (?='' OR u.repo_key=?)`).all(from, to, repo ?? "", repo ?? "");
  const all = sums(), byAgent = new Map<string, { agent: string; tasks: Set<string>; roots: Set<string>; attempts: number; sums: Sums; accepted: number; judged: number }>();
  const series = new Map<number, Map<string, number>>(), kinds = new Map<string, Map<string, Set<string>>>(), ladder = new Map<string, number>(), skips = new Map<string, number>();
  const step = BUCKET[bucket];
  for (const r of rows) {
    addRow(all, r);
    const agent = agentOf(r.executor);
    const g = byAgent.get(agent) ?? { agent, tasks: new Set(), roots: new Set(), attempts: 0, sums: sums(), accepted: 0, judged: 0 };
    byAgent.set(agent, g); g.tasks.add(r.task_id); g.roots.add(r.root_id); g.attempts++; addRow(g.sums, r);
    if (r.outcome === "accepted" || r.outcome === "rejected") { g.judged++; if (r.outcome === "accepted") g.accepted++; }
    const at = Math.floor(r.ended_at / step) * step, day = series.get(at) ?? new Map<string, number>();
    series.set(at, day); day.set(agent, (day.get(agent) ?? 0) + (r.total ?? 0));
    const kind = r.kind ?? "other", row = kinds.get(kind) ?? new Map<string, Set<string>>(), cell = row.get(agent) ?? new Set<string>();
    kinds.set(kind, row); row.set(agent, cell); cell.add(r.task_id);
    if (r.ladder_rule) ladder.set(r.ladder_rule, (ladder.get(r.ladder_rule) ?? 0) + 1);
    if (r.skipped) try {
      for (const s of JSON.parse(r.skipped) as { executor: string; reason: string }[]) {
        const key = JSON.stringify([agentOf(String(s.executor)), String(s.reason).slice(0, 200)]); skips.set(key, (skips.get(key) ?? 0) + 1);
      }
    } catch { /* malformed routing note: not counted */ }
  }
  const spread = [...byAgent.values()].sort((a, b) => b.sums.total - a.sums.total || a.agent.localeCompare(b.agent)).map(g => ({
    agent: g.agent, rootTasks: g.roots.size, tasks: g.tasks.size, subtasks: [...g.tasks].filter(id => !g.roots.has(id)).length, attempts: g.attempts, ...g.sums,
    // A share of zero tokens is unknown, not 0%.
    share: all.total > 0 ? g.sums.total / all.total : null, tokensPerTask: g.tasks.size ? Math.round(g.sums.total / g.tasks.size) : null,
    acceptanceRate: g.judged ? g.accepted / g.judged : null,
  }));
  return {
    rootTasksHandled: roots.length, subtasks, attempts: attemptsInTrees, retryAttempts, acceptedFirstTry, reviewedRoots: reviewed,
    acceptedFirstTryRate: reviewed ? acceptedFirstTry / reviewed : null,
    tokens: { ...all, attempts: rows.length, lowerBound: all.unknownAttempts > 0 || all.partialAttempts > 0 },
    spread,
    daily: [...series.entries()].sort((a, b) => a[0] - b[0]).map(([at, m]) => ({ at, byAgent: Object.fromEntries(m) })),
    kindByAgent: [...kinds.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([kind, m]) => ({ kind, byAgent: Object.fromEntries([...m].map(([a, set]) => [a, set.size])) })),
    ladder: [...ladder.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([rule, count]) => ({ rule, count })),
    skipReasons: [...skips.entries()].map(([k, count]) => { const [agent, reason] = JSON.parse(k) as [string, string]; return { agent, reason, count }; }).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)).slice(0, 20),
    rootIds: rootIds.length,
  };
}

/**
 * Where tokens went in a period. Token counts from different providers are volumes, not costs: shares and
 * "ran outside the planner" are ratios of volume and always travel with their coverage.
 */
export function insightsSummary(ctx: Ctx, input: InsightsInput) {
  const { from, to, repo, bucket } = input;
  const current = period(ctx, from, to, repo, bucket), span = to - from, previous = period(ctx, from - span, from, repo, bucket);
  const { rootIds: _a, ...cur } = current, { rootIds: _b, ...prev } = previous;
  return {
    from, to, bucket, ...(repo ? { repo } : {}), ...cur,
    // Planner tokens are not measured yet: clients show "Planner: not measured" and hide "ran outside the planner".
    planner: { coverage: "unknown" as const }, decision: { coverage: "unknown" as const },
    ranOutsidePlanner: null,
    previous: { rootTasksHandled: prev.rootTasksHandled, subtasks: prev.subtasks, retryAttempts: prev.retryAttempts, acceptedFirstTryRate: prev.acceptedFirstTryRate, tokens: prev.tokens },
  };
}
