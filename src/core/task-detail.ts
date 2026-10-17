import { readActivity } from "../activity/log";
import { buildExecutors } from "../api/read-model/capacity";
import { apiTask } from "../api/read-model/tasks";
import type { ApiTask, ExecutorRow } from "../api/read-model/types";
import { loadStrategy } from "../config/strategy";
import { executorsFor } from "../engine/rank";
import { executorName } from "../link/notification";
import { listTasks } from "../tasks/store";
import { TERMINAL_STATES, type Attempt, type Brief, type RoutingNote, type TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";
import { CoreError } from "./errors";
import { route, status } from "./routing";
import { diff, get, type DiffFile } from "./tasks";

export interface Cost {
  executor: { account: string; deltaPct: number | null; window: string | null; reason?: "shared" | "no_reading" } | null;
  planner: null;
}
export interface RetryOption { id: string; state: ExecutorRow["state"]; reason: string }
export interface TaskDetail extends ApiTask {
  brief: Brief;
  attempts: (Attempt & { log: string })[];
  routing: RoutingNote | null;
  cost: Cost;
  acceptance: { cmd: string | null; state: "pending" | "running" | "passed" | "failed" | "none"; tail: string; durationS?: number; summary?: string; machine: string | null };
  summary: string | null;
  branch: string | null;
  base: string | null;
  machine: string | null;
  startedAt: number | null;
  endedAt: number | null;
  files: DiffFile[];
  retryOptions: RetryOption[];
  timeline: { at: number; text: string }[];
}

async function optionsFor(ctx: Ctx, task: TaskRecord): Promise<RetryOption[]> {
  let strategy;
  try { strategy = loadStrategy(ctx); } catch { return []; }
  const [routing, st] = await Promise.all([route(ctx, task.kind, strategy), status(ctx, strategy)]);
  const rows = buildExecutors(st, strategy, listTasks(ctx, Infinity).map(t => apiTask(ctx, t)), ctx.now);
  const ran = task.result?.executor ?? task.executor ?? task.attempts.at(-1)?.executor;
  return [...new Set(executorsFor(task.kind, strategy))].filter(id => id !== ran).map(id => {
    const row = rows.find(r => r.id === id);
    const excluded = routing.excluded.find(r => r.id === id);
    const busy = row?.state === "busy" || row?.state === "full";
    return { id, state: row?.state ?? "down", reason: busy ? "busy" : row?.reason ?? excluded?.reason ?? (row?.state === "ready" ? "available" : row?.state ?? "not configured") };
  });
}

export function retryOptions(ctx: Ctx, id: string): Promise<RetryOption[]> {
  return optionsFor(ctx, get(ctx, id));
}

function costFor(ctx: Ctx, task: TaskRecord): Cost {
  const attempt = task.pendingAttempt ? undefined : task.attempts.at(-1);
  const start = task.pendingAttempt?.usageAtStart ?? attempt?.usageAtStart;
  if (!start) return { executor: null, planner: null };
  const end = attempt?.usageAtEnd;
  const from = attempt?.startedAt ?? task.run?.startedAt ?? task.attemptStartedAt ?? start.at;
  const until = attempt?.endedAt ?? ctx.now;
  const shared = listTasks(ctx, Infinity).some(other => {
    if (other.id === task.id) return false;
    const overlaps = (account: string | undefined, a: number, b: number) => account === start.account && a < until && b > from;
    if (other.attempts.some(a => overlaps(a.usageAtStart?.account ?? a.usageAtEnd?.account, a.startedAt, a.endedAt))) return true;
    return other.state === "running" && overlaps(other.pendingAttempt?.usageAtStart?.account, other.run?.startedAt ?? other.attemptStartedAt ?? other.createdAt, ctx.now);
  });
  const comparable = end && start.account === end.account && start.window === end.window && start.usedPct !== null && end.usedPct !== null && end.usedPct >= start.usedPct;
  const reason = shared ? "shared" : comparable ? undefined : "no_reading";
  return { executor: { account: start.account, window: start.window, deltaPct: reason ? null : Math.round((end!.usedPct! - start.usedPct!) * 10) / 10, ...(reason ? { reason } : {}) }, planner: null };
}

function timelineFor(ctx: Ctx, task: TaskRecord): TaskDetail["timeline"] {
  const timeline: TaskDetail["timeline"] = [];
  const attempts = task.attempts.length ? task.attempts : [{ startedAt: task.run?.startedAt ?? task.attemptStartedAt ?? task.createdAt, routing: task.pendingAttempt?.routing }];
  for (const attempt of attempts) {
    if (attempt.routing) timeline.push({ at: attempt.startedAt, text: `Routed to ${executorName(attempt.routing.chosen)} · ${attempt.routing.why}` });
  }
  if (task.worktree || task.run?.mode === "new") timeline.push({ at: attempts[0].startedAt, text: `Worktree created from ${task.baseBranch ?? "HEAD"}` });
  if (task.progress?.commits) timeline.push({ at: task.progress.lastChangeAt ?? task.progress.updatedAt, text: `${task.progress.commits} commit${task.progress.commits === 1 ? "" : "s"}` });
  if (task.progress?.phase === "testing") timeline.push({ at: task.progress.updatedAt, text: "Testing" });
  if (TERMINAL_STATES.includes(task.state)) timeline.push({ at: Math.max(task.attempts.at(-1)?.endedAt ?? task.createdAt, task.progress?.updatedAt ?? 0), text: task.state });
  let before: string | undefined;
  do {
    const page = readActivity(ctx, { taskId: task.id, limit: 500, before });
    timeline.push(...page.entries.map(e => ({ at: e.at, text: e.text })));
    before = page.next ?? undefined;
  } while (before);
  return timeline.sort((a, b) => a.at - b.at);
}

export async function taskDetail(ctx: Ctx, id: string): Promise<TaskDetail> {
  const task = get(ctx, id), last = task.attempts.at(-1);
  const [changes, retryOptions] = await Promise.all([
    diff(ctx, id).catch(error => {
      // Old/deleted checkouts still have useful task metadata.
      if (error instanceof CoreError && error.code === "invalid_input") return { files: [] as DiffFile[] };
      throw error;
    }),
    optionsFor(ctx, task),
  ]);
  const acceptance = task.result?.acceptance, terminal = TERMINAL_STATES.includes(task.state);
  const cmd = acceptance?.cmd ?? task.brief.acceptance ?? null;
  let branch = task.run?.remoteBranch ?? (task.run?.mode === "new" ? `pacer/${id}` : null);
  if (!branch) {
    const worktree = task.result?.worktree ?? task.worktree ?? task.run?.workdir ?? task.brief.repo;
    const result = await ctx.run(["git", "-C", worktree, "branch", "--show-current"], 10_000);
    if (result.code === 0) branch = result.stdout.trim() || null;
  }
  return {
    ...apiTask(ctx, task), brief: task.brief, attempts: task.attempts,
    routing: task.pendingAttempt?.routing ?? last?.routing ?? null, cost: costFor(ctx, task),
    acceptance: { cmd, state: acceptance ? acceptance.passed ? "passed" : "failed" : !cmd ? "none" : task.progress?.phase === "testing" ? "running" : "pending", tail: Buffer.from(acceptance?.tail ?? "").subarray(-4096).toString("utf8"), machine: acceptance?.machine ?? null, ...(acceptance?.durationS !== undefined ? { durationS: acceptance.durationS } : {}), ...(acceptance?.summary ? { summary: acceptance.summary } : {}) },
    summary: task.result?.report ?? null, branch, base: task.baseBranch ?? null, machine: task.run?.host ?? null,
    startedAt: task.attempts[0]?.startedAt ?? task.run?.startedAt ?? task.attemptStartedAt ?? null,
    endedAt: terminal ? last?.endedAt ?? null : null, files: changes.files, retryOptions, timeline: timelineFor(ctx, task),
  };
}
