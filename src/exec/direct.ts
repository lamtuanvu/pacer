import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderCfg } from "../config/strategy";
import { tasksDir } from "../tasks/store";
import type { Attempt, TaskRecord } from "../tasks/types";
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
  let launch: Launch;
  try {
    launch = launchFor(cfg, buildPrompt(task.brief, task.id), task.brief.repo, dir, task.id);
  } catch (e) {
    const exec = { code: 127, stdout: "", stderr: (e as Error).message, timedOut: false };
    await Bun.write(log, `--- launch error\n${exec.stderr}\n`);
    return outcome(cfg, startedAt, exec, log, exec.stderr);
  }
  const exec = await execProcess({
    argv: launch.argv, cwd: launch.cwd, stdin: launch.stdin, env: { ...ctx.env, PACER_ROLE: "executor" },
    timeoutMs: task.timeoutS * 1000, logFile: log, onSpawn,
  });
  let report = tail(exec.stdout.trim() || exec.stderr.trim(), REPORT_CHARS);
  if (launch.lastMessageFile && existsSync(launch.lastMessageFile)) {
    report = tail(readFileSync(launch.lastMessageFile, "utf8").trim(), REPORT_CHARS) || report;
  }
  return outcome(cfg, startedAt, exec, log, report);
}
