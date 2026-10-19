import { remoteExclusion } from "../remote/eligibility";
import { projectSnapshot } from "./project-policy";
import { repoFor } from "./repos";
import { repoFs, withTimeout } from "./path-probe";
import { join, resolve } from "node:path";
import { boundedGitRead } from "./git";
import { computeStatus } from "../engine/status";
import { rankExecutors } from "../engine/rank";
import { readJson } from "../fsutil";
import type { ActivityProfile } from "../pace/activity";
import { readActivity } from "../activity/log";
import { buildExecutors } from "../api/read-model/capacity";
import { apiTask, apiTasks } from "../api/read-model/tasks";
import type { ApiTask, ExecutorRow } from "../api/read-model/types";
import { loadStrategy } from "../config/strategy";
import { executorsFor } from "../engine/rank";
import { executorName } from "../link/notification";
import { listTasks } from "../tasks/store";
import { TERMINAL_STATES, type Attempt, type Brief, type RoutingNote, type TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";
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
  policyError?: string;
  timeline: { at: number; text: string }[];
  derived?: { files: "ready" | "unavailable"; branch: "ready" | "unavailable"; retryOptions: "cached"; timeline: "ready" | "partial" };
}

async function optionsFor(ctx: Ctx, task: TaskRecord, cacheOnly = false): Promise<RetryOption[]> {
  let strategy;
  try { strategy = loadStrategy(ctx); } catch { return []; }
  const selection = projectSnapshot(ctx, strategy, (task.repo ?? repoFor(ctx, task.brief.repo)).key).selection;
  // Reads use stored identity and never run Git or mutate the repository registry.
  const st = await computeStatus(ctx, strategy, cacheOnly ? {cacheOnly: true, profile: readJson<ActivityProfile>(join(ctx.pacerHome, "activity.json"))} : {});
  if (!cacheOnly) await Promise.all(st.providers.map(async provider => {
    const reason = await remoteExclusion(ctx, strategy, provider.id, {repo: task.brief.repo, placement: "new"});
    if (reason) provider.unavailableReason = reason;
  }));
  const routing = rankExecutors(task.kind, strategy, Object.fromEntries(st.providers.map(p => [p.id, p])), selection && { executors: selection.executors, order: "configured" });
  const rows = buildExecutors(st, strategy, apiTasks(ctx, listTasks(ctx, Infinity)), ctx.now);
  const ran = task.result?.executor ?? task.executor ?? task.attempts.at(-1)?.executor;
  return [...new Set(selection?.executors ?? executorsFor(task.kind, strategy))].filter(id => id !== ran).map(id => {
    const row = rows.find(r => r.id === id);
    const excluded = routing.excluded.find(r => r.id === id);
    const busy = row?.state === "busy" || row?.state === "full";
    return { id, state: selection && excluded ? "down" : row?.state ?? "down", reason: busy ? "busy" : (selection ? excluded?.reason ?? row?.reason : row?.reason ?? excluded?.reason) ?? (row?.state === "ready" ? "available" : row?.state ?? "not configured") };
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
  // The review timeline is recent evidence. Full history remains available via activity.list.
  const page = readActivity(ctx, { taskId: task.id, limit: 500, maxBytes: 256 * 1024 });
  timeline.push(...page.entries.map(e => ({ at: e.at, text: e.text })));
  return timeline.sort((a, b) => a.at - b.at);
}

type GitSummary = { files: DiffFile[]; branch: string | null; filesState: "ready" | "unavailable"; branchState: "ready" | "unavailable" };
const summaries = new Map<string, { key: string; at: number; value: Promise<GitSummary> }>();
async function stamp(path: string): Promise<string> {
  try { const s = await repoFs.stat(path); return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; } catch { return "missing"; }
}
async function worktreeStamp(worktree: string): Promise<string> {
  let git = join(worktree, ".git");
  try {
    if ((await repoFs.stat(git)).isFile()) git = resolve(worktree, (await repoFs.readText(git)).trim().replace(/^gitdir: /, ""));
    const head = await repoFs.readText(join(git, "HEAD"));
    const common = await repoFs.readText(join(git, "commondir")).catch(() => ".");
    const ref = head.startsWith("ref: ") ? head.slice(5).trim() : "HEAD";
    return JSON.stringify([head, ...await Promise.all([worktree, join(git, "index"), resolve(git, common.trim(), ref), resolve(git, common.trim(), "packed-refs")].map(stamp))]);
  } catch { return stamp(worktree); }
}
async function gitSummary(ctx: Ctx, task: TaskRecord): Promise<GitSummary> {
  const worktree = task.run?.host ? task.result?.worktree ?? task.brief.repo : task.run?.workdir ?? task.worktree ?? task.result?.worktree ?? task.brief.repo;
  // Metadata invalidates commits/index changes without spawning git. TTL catches nested unstaged edits and base-ref changes.
  const key = JSON.stringify([task.rev, worktree, await withTimeout(() => worktreeStamp(worktree), 250).catch(() => "unavailable")]), id = `${ctx.pacerHome}:${task.id}`;
  const hit = summaries.get(id);
  if (hit?.key === key && Date.now() - hit.at < 5000) return hit.value;
  const knownBranch = task.run?.remoteBranch ?? (task.run?.mode === "new" ? `pacer/${task.id}` : null);
  const value = Promise.all([
    diff(ctx, task.id, {summaryOnly: true}).then(r => ({files: r.files, filesState: "ready" as const})).catch(() => ({files: [], filesState: "unavailable" as const})),
    knownBranch ? Promise.resolve({branch: knownBranch, branchState: "ready" as const})
      : boundedGitRead(ctx.run, ["git", "-C", worktree, "branch", "--show-current"]).then(r => ({branch: r.code === 0 ? r.stdout.trim() || null : null, branchState: r.code === 0 ? "ready" as const : "unavailable" as const})).catch(() => ({branch: null, branchState: "unavailable" as const})),
  ]).then(([files, branch]) => ({...files, ...branch}));
  if (summaries.size >= 200) summaries.delete(summaries.keys().next().value!);
  summaries.set(id, {key, at: Date.now(), value});
  return value;
}

export async function taskDetail(ctx: Ctx, id: string): Promise<TaskDetail> {
  const task = get(ctx, id), last = task.attempts.at(-1);
  let policyError: string | undefined;
  const [changes, retryOptions] = await Promise.all([gitSummary(ctx, task), optionsFor(ctx, task, true).catch(error => { policyError = error instanceof Error ? error.message : String(error); return []; })]);
  const acceptance = task.result?.acceptance, terminal = TERMINAL_STATES.includes(task.state);
  const cmd = acceptance?.cmd ?? task.brief.acceptance ?? null;
  return {
    ...(policyError ? { policyError } : {}),
    ...apiTask(ctx, task), brief: task.brief, attempts: task.attempts,
    routing: task.pendingAttempt?.routing ?? last?.routing ?? null, cost: costFor(ctx, task),
    acceptance: { cmd, state: acceptance ? acceptance.passed ? "passed" : "failed" : !cmd ? "none" : task.progress?.phase === "testing" ? "running" : "pending", tail: Buffer.from(acceptance?.tail ?? "").subarray(-4096).toString("utf8"), machine: acceptance?.machine ?? null, ...(acceptance?.durationS !== undefined ? { durationS: acceptance.durationS } : {}), ...(acceptance?.summary ? { summary: acceptance.summary } : {}) },
    summary: task.result?.report ?? null, branch: changes.branch, base: task.baseBranch ?? null, machine: task.run?.host ?? null,
    startedAt: task.attempts[0]?.startedAt ?? task.run?.startedAt ?? task.attemptStartedAt ?? null,
    endedAt: terminal ? last?.endedAt ?? null : null, files: changes.files, retryOptions, timeline: timelineFor(ctx, task),
    derived: {files: changes.filesState, branch: changes.branchState, retryOptions: "cached", timeline: "partial"},
  };
}
