import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { KINDS, type Strategy, loadStrategy } from "../config/strategy";
import { killTree } from "../exec/process";
import type { Ctx } from "../types";
import { createTask, readTask, updateTask } from "./store";
import { type Brief, TERMINAL_STATES, type TaskRecord } from "./types";

export const DEFAULT_TIMEOUT_MIN = 30;

export class DelegateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DelegateError";
  }
}

export interface DelegateInput { brief: Brief; kind?: string | null; executor?: string | null; timeoutMin?: number }
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
  return p;
}

export function delegate(
  ctx: Ctx, input: DelegateInput, spawnFn: SpawnRunner = spawnRunner, s: Strategy = loadStrategy(ctx),
): TaskRecord {
  const problems = validateInput(s, input);
  if (problems.length) throw new DelegateError(problems.join("; "));
  const task = createTask(ctx, {
    brief: input.brief,
    kind: input.kind ?? null,
    requestedExecutor: input.executor ?? null,
    timeoutS: Math.round((input.timeoutMin ?? DEFAULT_TIMEOUT_MIN) * 60),
  });
  spawnFn(ctx, task.id);
  return task;
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

/** Read a task; missing or dead runners become failed. */
export function taskStatus(ctx: Ctx, id: string): TaskRecord | null {
  const t = readTask(ctx, id);
  if (!t) return null;
  const neverStarted = t.state === "queued" && !t.runnerPid && ctx.now - t.createdAt > 60;
  if (neverStarted || (t.state === "running" && !alive(t.runnerPid))) {
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
  const deadline = Date.now() + timeoutS * 1000;
  for (;;) {
    const t = taskStatus(ctx, id);
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
