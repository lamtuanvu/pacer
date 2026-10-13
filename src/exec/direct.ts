import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadStrategy } from "../config/strategy";
import { validateExecution } from "../config/execution";
import { pidAlive } from "../link/store";
import { gitInfo, realpathSafe } from "./orca/setup";
import type { ProviderCfg } from "../config/strategy";
import { tasksDir, listTasks, updateTask } from "../tasks/store";
import { resolvePlacement, type Attempt, type TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";
import { type Launch, launchFor } from "./launch";
import { detectLimit } from "./limits";
import { type ExecResult, execProcess } from "./process";
import { buildPrompt } from "./prompt";

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

/** One executor attempt through the executor's own CLI (the "direct" backend). */
export async function runAttempt(
  ctx: Ctx, cfg: ProviderCfg, task: TaskRecord, onSpawn?: (pid: number) => void,
): Promise<AttemptOutcome> {
  const dir = tasksDir(ctx);
  mkdirSync(dir, { recursive: true });
  const startedAt = Date.now() / 1000;
  const log = join(dir, `${task.id}.${cfg.id}.log`);
  let strategy: "child-of-current"|"new-child"|"current"="child-of-current";
  try{strategy=validateExecution(loadStrategy(ctx).execution).worktree;}catch{}
  const git=await gitInfo(ctx.run,task.brief.repo).catch(()=>({error:"git unavailable"})), top=realpathSafe("error" in git?task.brief.repo:git.top);
  const busy=listTasks(ctx,Infinity).some(t=>{const path=realpathSafe(t.worktree??t.result?.worktree??t.brief.repo);return t.id!==task.id&&t.state==="running"&&!!t.runnerPid&&pidAlive(t.runnerPid)&&(path===top||path.startsWith(top+"/"));});
  const resolved=resolvePlacement(task,strategy,busy,!("error" in git)&&git.dirty);
  if(busy || (resolved.mode==="current"&&resolved.why==="strategy default"&&!("error" in git)&&git.dirty)) {
    const reason=busy?"another pacer task is running in the current worktree; in-place execution refused":"current worktree has uncommitted changes";
    return outcome(cfg,startedAt,{code:1,stdout:"",stderr:reason,timedOut:false},log,reason);
  }
  updateTask(ctx,task.id,t=>{t.placement={requested:task.placement?.requested??"auto",...task.placement,mode:"current",why:resolved.why};t.worktree=task.brief.repo;});
  const note=resolved.mode==="new"?"ran in place: worktree isolation needs the Orca backend\n\n":"";
  let launch: Launch;
  try {
    launch = launchFor(cfg, buildPrompt(task.brief, task.id), task.brief.repo, dir, task.id);
  } catch (e) {
    const exec = { code: 127, stdout: "", stderr: (e as Error).message, timedOut: false };
    await Bun.write(log, `--- launch error\n${exec.stderr}\n`);
    return outcome(cfg, startedAt, exec, log, note+exec.stderr);
  }
  const exec = await execProcess({
    argv: launch.argv, cwd: launch.cwd, stdin: launch.stdin, env: { ...ctx.env, PACER_ROLE: "executor" },
    timeoutMs: task.timeoutS * 1000, logFile: log, onSpawn,
  });
  let report = tail(exec.stdout.trim() || exec.stderr.trim(), REPORT_CHARS);
  if (launch.lastMessageFile && existsSync(launch.lastMessageFile)) {
    report = tail(readFileSync(launch.lastMessageFile, "utf8").trim(), REPORT_CHARS) || report;
  }
  return outcome(cfg, startedAt, exec, log, note+report);
}
