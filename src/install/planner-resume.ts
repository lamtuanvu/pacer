import { spawn } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { appendActivity } from "../activity/log";
import { plannerResumeEnv } from "../exec/process";
import type { PlannerKind } from "../messaging/identity";
import type { Ctx } from "../types";

/** Reach shape this adapter needs; Task 6's CallerReach (kind, session?, cwd) satisfies it structurally. */
export interface PlannerReach { kind: PlannerKind; session?: string; cwd: string }
export interface ResumeSpawn { argv: string[]; cwd: string; env: Record<string, string | undefined>; log: string }
export type ResumeSpawner = (o: ResumeSpawn) => number | undefined;
export interface ResumeDeps { task: string; isAlive: () => Promise<boolean>; spawn?: ResumeSpawner }

/** A session id is a local input, never a flag: both CLIs parse a leading `-` as an option otherwise. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Codex answers `codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]` (verified with codex exec resume --help). */
export function resumeArgv(kind: PlannerKind, session: string, prompt: string): string[] | null {
  if (!SESSION_ID.test(session)) return null;
  if (kind === "claude-code") return ["claude", `--resume=${session}`, "-p", "--", prompt];
  if (kind === "codex") return ["codex", "exec", "resume", "--", session, prompt];
  return null;
}

const nativeSession = (kind: PlannerKind, session: string) => session.startsWith(`${kind}:`) ? session.slice(kind.length + 1) : session;
const segment = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 96);
const nextLogIndex = (dir: string) => {
  let n = 1;
  try { for (const f of readdirSync(dir)) { const m = /^(\d+)\.log$/.exec(f); if (m) n = Math.max(n, Number(m[1]) + 1); } } catch { /* a missing dir starts at 1 */ }
  return n;
};

/** Detached with its own session, output to the resume log: the runner spawn pattern (SEC-5 runs argv, never a shell). */
export const spawnResume: ResumeSpawner = ({ argv, cwd, env, log }) => {
  const [cmd, ...pre] = argv;
  if (!cmd) return undefined;
  let fd: number | "ignore" = "ignore";
  try { fd = openSync(log, "a", 0o600); } catch { /* a log that cannot be opened never blocks a launch */ }
  try {
    const child = spawn(cmd, pre, { detached: true, cwd, env, stdio: ["ignore", fd, fd] });
    // A missing planner binary must not take the broker down; say why in the resume log.
    child.on("error", e => { try { appendFileSync(log, `${e}\n`); } catch { /* nothing left to report */ } });
    child.unref();
    return child.pid;
  } finally { if (fd !== "ignore") closeSync(fd); }
};

/** Resume a closed caller session in the background so its resumed turn can decide the pending task.
 * Refuses while the caller session is still open: an attended turn needs no resume. */
export async function resumeCaller(ctx: Ctx, reach: PlannerReach, prompt: string, deps: ResumeDeps): Promise<"resumed" | "unavailable"> {
  if (await deps.isAlive()) return "unavailable";
  const session = nativeSession(reach.kind, reach.session ?? "");
  const argv = resumeArgv(reach.kind, session, prompt);
  if (!argv) return "unavailable";
  if (!isAbsolute(reach.cwd) || !statSync(reach.cwd, { throwIfNoEntry: false })?.isDirectory()) return "unavailable";
  const dir = join(ctx.pacerHome, "runs", `caller-${segment(session)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const log = join(dir, `${nextLogIndex(dir)}.log`);
  try { closeSync(openSync(log, "a", 0o600)); } catch { /* a log that cannot be created never blocks a launch */ }
  const env = { ...plannerResumeEnv(ctx.env), HOME: ctx.home, PACER_HOME: ctx.pacerHome, PACER_PLANNER_SESSION: `${reach.kind}:${session}`, PACER_CALLER_RESUME: deps.task };
  let pid: number | undefined, failure: unknown;
  try { pid = (deps.spawn ?? spawnResume)({ argv, cwd: reach.cwd, env, log }); } catch (e) { failure = e; }
  // No pid means nothing started: the record would be false and the ladder could not escalate.
  if (pid === undefined) {
    try { appendFileSync(log, `${failure === undefined ? "spawn returned no pid" : String(failure)}\n`); } catch { /* nothing left to report */ }
    return "unavailable";
  }
  appendActivity(ctx, { kind: "message", level: "info", text: `caller resumed for ${deps.task}`, taskId: deps.task });
  return "resumed";
}
