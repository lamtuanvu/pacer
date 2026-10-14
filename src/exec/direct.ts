import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadStrategy, type ProviderCfg } from "../config/strategy";
import { type ExecutionCfg, validateExecution } from "../config/execution";
import { pidAlive } from "../link/store";
import { gitInfo, realpathSafe } from "../core/git";
import { tasksDir, listTasks, readTask, updateTask } from "../tasks/store";
import { resolvePlacement, type Attempt, type RunRef, type TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";
import { launchFor } from "./launch";
import { detectLimit } from "./limits";
import type { ExecResult } from "./process";
import { buildPrompt } from "./prompt";
import { readOutput, startRun } from "../supervisor/run";
import { type SuperviseEnd, supervise } from "../supervisor/supervise";
import { createTaskWorktree } from "../supervisor/worktree";

export const REPORT_CHARS = 4000;

export interface AttemptOutcome { attempt: Attempt; exec: ExecResult; report: string; backend?: string; worktree?: string }

export function tail(s: string, n: number): string {
  return s.length > n ? s.slice(-n) : s;
}

function outcome(cfg: ProviderCfg, startedAt: number, exec: ExecResult, log: string, report: string): AttemptOutcome {
  return {
    backend: "direct",
    exec,
    report,
    attempt: {
      executor: cfg.id, model: cfg.model, startedAt, endedAt: Date.now() / 1000,
      exitCode: exec.code, timedOut: exec.timedOut, limitHit: detectLimit(cfg.id, exec), log,
    },
  };
}

export const runDir = (ctx: Ctx, taskId: string, attempt: number) => join(ctx.pacerHome, "runs", taskId, String(attempt));

function loadExec(ctx: Ctx): ExecutionCfg {
  try { return validateExecution(loadStrategy(ctx).execution); } catch { return validateExecution(undefined); }
}

/** Shared tail of a fresh or resumed attempt: supervise, collect files, write the legacy log, build the outcome. */
async function finishRun(ctx: Ctx, cfg: ProviderCfg, task: TaskRecord, run: RunRef, note: string, onPoll?: Parameters<typeof supervise>[0]["onPoll"]): Promise<AttemptOutcome> {
  const end: SuperviseEnd = await supervise({
    dir: run.dir, deadlineMs: (run.startedAt + task.timeoutS) * 1000,
    isStopped: () => readTask(ctx, task.id)?.state === "stopped", onPoll,
  });
  const out = readOutput(run.dir);
  const exec: ExecResult = { code: end.code, stdout: out.stdout, stderr: out.stderr, timedOut: end.kind === "timeout" };
  if (end.kind === "idle") exec.stderr += `\npacer: stopped after ${Math.round(((loadExec(ctx) as { idleFailS?: number }).idleFailS ?? 1800) / 60)} min without output or file changes`;
  if (end.kind === "lost") exec.stderr += "\npacer: the attempt's wrapper vanished without an exit record";
  try {
    writeFileSync(run.logFile, `$ ${launchArgv(run)}\n--- stdout\n${exec.stdout}\n--- stderr\n${exec.stderr}\n--- exit ${exec.code}${exec.timedOut ? " (timed out)" : ""}\n`);
  } catch { /* the run directory keeps the full record */ }
  let report = tail(exec.stdout.trim() || exec.stderr.trim(), REPORT_CHARS);
  if (run.lastMessageFile && existsSync(run.lastMessageFile)) report = tail(readFileSync(run.lastMessageFile, "utf8").trim(), REPORT_CHARS) || report;
  return {
    ...outcome(cfg, run.startedAt, exec, run.logFile, note + report),
    ...(run.mode === "new" ? { worktree: run.workdir } : {}),
  };
}

const launchArgv = (run: RunRef) => { try { return readFileSync(join(run.dir, "argv"), "utf8"); } catch { return ""; } };

/** One executor attempt through the executor's own CLI, under the file-backed supervisor. */
export async function runAttempt(ctx: Ctx, cfg: ProviderCfg, task: TaskRecord, onSpawn?: (pid: number) => void): Promise<AttemptOutcome> {
  const dir = tasksDir(ctx);
  mkdirSync(dir, { recursive: true });
  const startedAt = Date.now() / 1000, log = join(dir, `${task.id}.${cfg.id}.log`), ex = loadExec(ctx);
  const git = await gitInfo(ctx.run, task.brief.repo).catch(() => ({ error: "git unavailable" }));
  const top = realpathSafe("error" in git ? task.brief.repo : git.top);
  const busy = listTasks(ctx, Infinity).some(t => { const path = realpathSafe(t.worktree ?? t.result?.worktree ?? t.brief.repo); return t.id !== task.id && t.state === "running" && !!t.runnerPid && pidAlive(t.runnerPid) && t.placement?.mode === "current" && (path === top || path.startsWith(top + "/")); });
  let resolved = resolvePlacement(task, ex.worktree, busy, !("error" in git) && git.dirty);
  let note = "", workdir = task.brief.repo, mode: "current" | "new" = resolved.mode;
  if (mode === "new" && "error" in git) {
    note = `ran in place: ${git.error}\n\n`; mode = "current"; resolved = { mode: "current", why: resolved.why };
  }
  if (mode === "current" && (busy || (resolved.why === "strategy default" && !("error" in git) && git.dirty))) {
    const reason = busy ? "another pacer task is running in the current worktree; in-place execution refused" : "current worktree has uncommitted changes";
    return outcome(cfg, startedAt, { code: 1, stdout: "", stderr: reason, timedOut: false }, log, reason);
  }
  if (mode === "new" && !("error" in git)) {
    const base = ex.worktree === "child-of-current" ? git.branch : ex.baseBranch ?? git.branch;
    if (base === "HEAD") {
      const reason = `${git.top} has a detached HEAD; check out a branch or set execution.base_branch`;
      return outcome(cfg, startedAt, { code: 1, stdout: "", stderr: reason, timedOut: false }, log, reason);
    }
    // Fallback executors continue the same task worktree, including prior work.
    const existing = task.attempts.length > 0 && task.run?.mode === "new" ? task.run : null;
    const w = existing
      ? { workdir: existing.workdir }
      : await createTaskWorktree(ctx, git, task.id, base);
    if ("error" in w) return outcome(cfg, startedAt, { code: 1, stdout: "", stderr: w.error, timedOut: false }, log, w.error);
    workdir = w.workdir;
    if (git.dirty) note = `note: ${git.top} has uncommitted changes; the task's worktree starts from ${base} without them\n\n`;
    if (!existing) updateTask(ctx, task.id, t => { t.baseBranch = base; });
  }
  const attempt = task.attempts.length + 1, rdir = runDir(ctx, task.id, attempt);
  updateTask(ctx, task.id, t => {
    t.placement = { requested: task.placement?.requested ?? "auto", ...task.placement, mode, why: resolved.why };
    t.worktree = workdir;
  });
  const prompt = mode === "new"
    ? buildPrompt({ ...task.brief, repo: `${workdir} (a new git worktree of ${task.brief.repo} on branch pacer/${task.id}; do not edit ${task.brief.repo} itself)` }, task.id)
    : buildPrompt(task.brief, task.id);
  let launch: ReturnType<typeof launchFor>;
  try {
    launch = launchFor(cfg, prompt, workdir, rdir, task.id);
  } catch (e) {
    const exec = { code: 127, stdout: "", stderr: (e as Error).message, timedOut: false };
    await Bun.write(log, `--- launch error\n${exec.stderr}\n`);
    return outcome(cfg, startedAt, exec, log, note + exec.stderr);
  }
  mkdirSync(rdir, { recursive: true });
  writeFileSync(join(rdir, "argv"), launch.argv.join(" "));
  const run: RunRef = { dir: rdir, attempt, executor: cfg.id, startedAt, mode, workdir, logFile: log, ...(launch.lastMessageFile ? { lastMessageFile: launch.lastMessageFile } : {}) };
  updateTask(ctx, task.id, t => { t.run = run; });
  const started = startRun({ dir: rdir, argv: launch.argv, cwd: launch.cwd, stdin: launch.stdin, env: { ...ctx.env, PACER_ROLE: "executor" } });
  if ("error" in started) {
    const exec = { code: 127, stdout: "", stderr: started.error, timedOut: false };
    return outcome(cfg, startedAt, exec, log, note + started.error);
  }
  try { onSpawn?.(started.pid); } catch { /* the run continues regardless */ }
  return finishRun(ctx, cfg, task, run, note);
}

/** Re-attach to an attempt whose pacer runner died (Task 6). */
export async function resumeAttempt(ctx: Ctx, cfg: ProviderCfg, task: TaskRecord): Promise<AttemptOutcome> {
  if (!task.run) throw new Error(`task ${task.id} has no run to resume`);
  return finishRun(ctx, cfg, task, task.run, "");
}
