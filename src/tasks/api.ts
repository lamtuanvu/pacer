import { z } from "zod";
import { appendLabel } from "./labels";
import { readBlocked } from "../executors/blocked";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { KINDS, type Strategy, loadStrategy } from "../config/strategy";
import { killTree } from "../exec/process";
import { readRun } from "../supervisor/run";
import type { Ctx } from "../types";
import { createTask, readTask, updateTask } from "./store";
import { type Brief, TERMINAL_STATES, type TaskRecord, type WorktreeRequest } from "./types";

export const EXECUTOR_DELEGATE_ERROR = "PACER_ROLE=executor: pacer executors cannot delegate onward; complete the assigned task directly.";
export const delegateSchema = {
  goal: z.string().min(1), repo: z.string().min(1),
  scope: z.string().optional(), acceptance: z.string().optional(), constraints: z.string().optional(), context: z.string().optional(),
  kind: z.enum(KINDS).optional(), executor: z.string().optional(),
  worktree: z.enum(["current", "new", "auto"]).optional(), worktree_reason: z.string().max(200).optional(),
  timeout_min: z.number().min(1).max(240).optional(),
};
export function parseDelegateBrief(raw: unknown, defaultRepo: string): DelegateInput {
  const parsed=z.object(delegateSchema).safeParse({repo:defaultRepo,...(raw as object)});
  if(!parsed.success)throw new DelegateError(parsed.error.issues.map(i=>i.path[0]==="worktree"?"worktree must be one of current, new, auto":i.path[0]==="worktree_reason"?"worktree_reason must be a string of at most 200 characters":`${i.path.join(".")}: ${i.message}`).join("; "));
  const a=parsed.data;
  return { brief: { goal:a.goal, repo:a.repo, scope:a.scope, acceptance:a.acceptance, constraints:a.constraints, context:a.context },
    kind:a.kind, executor:a.executor, timeoutMin:a.timeout_min, worktree:a.worktree, worktree_reason:a.worktree_reason };
}
export function summarizeTask(t: TaskRecord): Record<string, unknown> {
  return { task_id:t.id, state:t.state, kind:t.kind, requested_executor:t.requestedExecutor, placement:t.placement??null,
    attempts:t.attempts.map(a=>({executor:a.executor,exit_code:a.exitCode,limit_hit:a.limitHit,timed_out:a.timedOut,log:a.log})),
    result:t.result??null, review:t.review??null, resolved:t.resolved??null };
}
export function taskReview(ctx: Ctx, id: string, accepted: boolean, kind?: string, note?: string): {recorded:true} {
  const t=taskStatus(ctx,id); if(!t)throw new Error(`unknown task ${id}`);
  if(kind && !(KINDS as readonly string[]).includes(kind))throw new Error(`unknown kind "${kind}"`);
  appendLabel(ctx,{type:"task_review",task_id:id,accepted,kind:kind??t.kind,note:note??null,executor:t.result?.executor??null});
  updateTask(ctx,id,x=>{x.review={accepted,kind:kind??t.kind,note:note??null,at:ctx.now};x.resolved="reviewed";});
  return {recorded:true};
}
export function taskDismiss(ctx: Ctx, id: string): TaskRecord | null {
  return readTask(ctx,id) ? updateTask(ctx,id,t=>{t.dismissed=true;}) : null;
}

export const DEFAULT_TIMEOUT_MIN = 30;

export class DelegateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DelegateError";
  }
}

export interface DelegateInput { brief: Brief; kind?: string | null; executor?: string | null; timeoutMin?: number; retryOf?: string; force?: boolean; worktree?: WorktreeRequest; worktree_reason?: string }
export type SpawnRunner = (ctx: Ctx, taskId: string) => number | undefined;

/** How to re-invoke this pacer: `bun src/cli.ts` in development, the compiled binary otherwise. */
export function selfCommand(argv: string[] = process.argv, execPath: string = process.execPath): string[] {
  const script = argv[1] ?? "";
  return /\.(ts|js|mjs)$/.test(script) ? [execPath, script] : [execPath];
}

export const spawnRunner: SpawnRunner = (ctx, taskId) => {
  const [cmd, ...pre] = selfCommand();
  const child = spawn(cmd, [...pre, "_run", taskId], {
    detached: true,
    stdio: "ignore",
    env: { ...ctx.env, HOME: ctx.home, PACER_HOME: ctx.pacerHome },
  });
  child.unref();
  return child.pid;
};

export function validateInput(s: Strategy, input: DelegateInput): string[] {
  const p: string[] = [];
  const b = input.brief;
  if (!b.goal?.trim()) p.push("goal is required");
  if (!b.repo || !isAbsolute(b.repo)) p.push("repo must be an absolute path");
  else if (!existsSync(b.repo) || !statSync(b.repo).isDirectory()) p.push(`repo does not exist: ${b.repo}`);
  if (input.kind && !(KINDS as readonly string[]).includes(input.kind)) {
    p.push(`unknown kind "${input.kind}" (allowed: ${KINDS.join(", ")})`);
  }
  if (input.executor && !s.providers[input.executor]) {
    p.push(`unknown executor "${input.executor}" (configured: ${Object.keys(s.providers).join(", ")})`);
  } else if (input.executor && input.executor === s.planner) {
    p.push(`"${input.executor}" is the planner; pick an executor`);
  }
  if (input.timeoutMin !== undefined && !(input.timeoutMin >= 1 && input.timeoutMin <= 240)) {
    p.push("timeout_min must be between 1 and 240");
  }
  if(input.worktree!==undefined && !["current","new","auto"].includes(input.worktree))p.push("worktree must be one of current, new, auto");
  if(input.worktree_reason!==undefined && (typeof input.worktree_reason!=="string" || input.worktree_reason.length>200))p.push("worktree_reason must be a string of at most 200 characters");
  return p;
}

export function delegate(
  ctx: Ctx, input: DelegateInput, spawnFn: SpawnRunner = spawnRunner, s: Strategy = loadStrategy(ctx),
): TaskRecord {
  const problems = validateInput(s, input);
  if(input.executor && readBlocked(ctx)[input.executor])problems.push(`${input.executor}: Blocked by you; run pacer executor unblock ${input.executor}`);
  if (problems.length) throw new DelegateError(problems.join("; "));
  const task = createTask(ctx, {
    brief: input.brief,
    kind: input.kind ?? null,
    requestedExecutor: input.executor ?? null,
    timeoutS: Math.round((input.timeoutMin ?? DEFAULT_TIMEOUT_MIN) * 60),
  });
  updateTask(ctx,task.id,t=>{t.placement={requested:input.worktree??"auto",...(input.worktree_reason!==undefined?{reason:input.worktree_reason}:{})};});
  if(input.force)updateTask(ctx,task.id,t=>{t.force=true;});
  if (input.retryOf) updateTask(ctx, task.id, t => { t.retryOf = input.retryOf; });
  spawnFn(ctx, task.id);
  return readTask(ctx,task.id)!;
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const isTerminal = (t: TaskRecord) => TERMINAL_STATES.includes(t.state);

/** Read a task; resume recoverable attempts before failing missing or dead runners. */
export function taskStatus(ctx: Ctx, id: string, spawn: SpawnRunner = spawnRunner): TaskRecord | null {
  const t = readTask(ctx, id);
  if (!t) return null;
  const run = t.run, current = run && run.attempt > t.attempts.length;
  if (t.state === "running" && current && !alive(t.runnerPid)) {
    const r = readRun(run.dir);
    if (r.alive || r.exit !== null) {
      if (!t.resumeSpawnedAt || ctx.now - t.resumeSpawnedAt >= 60) {
        updateTask(ctx, id, x => { x.resumeSpawnedAt = ctx.now; });
        try { spawn(ctx, id); } catch { /* the next status read tries again */ }
      }
      return readTask(ctx, id);
    }
  }
  const neverStarted = ["queued", "running"].includes(t.state) && !t.attemptStartedAt && !t.attempts.length && !alive(t.runnerPid) && ctx.now - t.createdAt > 600;
  if (neverStarted || (t.state === "running" && (t.attempts.length > 0 || t.attemptStartedAt !== undefined || ctx.now - t.createdAt > 600) && !alive(t.runnerPid))) {
    return updateTask(ctx, id, (x) => {
      if (TERMINAL_STATES.includes(x.state)) return;
      x.state = "failed";
      x.result = {
        status: "failed", executor: x.attempts.at(-1)?.executor ?? null, model: null, files: "",
        report: neverStarted ? "the pacer runner never started" : "the pacer runner exited unexpectedly", backend: "direct",
      };
    });
  }
  return t;
}

export async function taskWait(ctx: Ctx, id: string, timeoutS: number, pollMs = 1000): Promise<TaskRecord | null> {
  const started = Date.now(), deadline = started + timeoutS * 1000;
  for (;;) {
    const t = taskStatus({...ctx,now:ctx.now+(Date.now()-started)/1000}, id);
    if (!t || isTerminal(t) || Date.now() >= deadline) return t;
    await Bun.sleep(pollMs);
  }
}

/** Mark a task stopped and kill its executor; a live runner then finalizes it as stopped. */
export function taskStop(ctx: Ctx, id: string): TaskRecord | null {
  const t = readTask(ctx, id);
  if (!t) return null;
  if (isTerminal(t)) return t;
  const runnerAlive = t.state === "running" && alive(t.runnerPid);
  const updated = updateTask(ctx, id, (x) => {
    if (TERMINAL_STATES.includes(x.state)) return;
    x.state = "stopped";
    if (!runnerAlive) {
      x.result = { status: "stopped", executor: null, model: null, files: "", report: "stopped before an executor ran", backend: "direct" };
    }
  });
  if (t.childPid) killTree(t.childPid, "SIGTERM");
  return updated;
}
