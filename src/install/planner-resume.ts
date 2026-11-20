import { spawn } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { appendActivity } from "../activity/log";
import { cachedLoginPath } from "../exec/login-env";
import { plannerResumeEnv } from "../exec/process";
import { processIdentity, sameProcess, type ProcessIdentity } from "../update/desktop/process-identity";
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
/**
 * The unattended turn may only read and record a decision (maintainer decision, design §3): pacer's decision
 * commands and read-only file tools, nothing that edits, builds, pushes, delegates or changes configuration.
 * The user's and project's own allow rules, hooks and MCP servers must not widen this, so the built-in tool set
 * is fixed, project and local settings and MCP servers are not loaded, and anything else is denied unasked.
 */
export const RESUME_DECISION_COMMANDS = ["pacer review", "pacer msg inbox", "pacer msg read", "pacer msg send", "pacer msg log",
  "pacer tasks", "pacer wait", "pacer task request-review"];
export const RESUME_ALLOWED_TOOLS = [...RESUME_DECISION_COMMANDS.map(c => `Bash(${c}:*)`), "Read", "Grep", "Glob"];
export const RESUME_DENIED_TOOLS = ["Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Agent", "Task", "mcp__*"];

export function resumeArgv(kind: PlannerKind, session: string, prompt: string): string[] | null {
  if (!SESSION_ID.test(session)) return null;
  // --restricted ignores user, project and local settings (their allow rules and hooks) and keeps only the named tools.
  if (kind === "claude-code") return ["claude", `--resume=${session}`, "-p", "--restricted", "--permission-mode", "dontAsk",
    "--permission-prompts", "none", "--tools", "Bash,Read,Grep,Glob", "--strict-mcp-config",
    "--allowedTools", ...RESUME_ALLOWED_TOOLS, "--disallowedTools", ...RESUME_DENIED_TOOLS, "--", prompt];
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

/** Whether the turn last resumed for this session is still running (same process identity, not a reused pid). */
function resumedRunning(dir: string): boolean {
  try {
    const want = JSON.parse(readFileSync(join(dir, "active.json"), "utf8")) as ProcessIdentity;
    const now = processIdentity(want.pid);
    return !!now && sameProcess(now, want);
  } catch { return false; }
}

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
export async function resumeCaller(ctx: Ctx, reach: PlannerReach, prompt: string, deps: ResumeDeps): Promise<"resumed" | "busy" | "unavailable"> {
  if (await deps.isAlive()) return "unavailable";
  const session = nativeSession(reach.kind, reach.session ?? "");
  const argv = resumeArgv(reach.kind, session, prompt);
  if (!argv) return "unavailable";
  if (!isAbsolute(reach.cwd) || !statSync(reach.cwd, { throwIfNoEntry: false })?.isDirectory()) return "unavailable";
  const dir = join(ctx.pacerHome, "runs", `caller-${segment(session)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // One resumed turn per session at a time: a second resume would share the conversation unattended.
  if (resumedRunning(dir)) return "busy";
  // The service's PATH may not reach the planner CLI; use the login PATH executors get, and refuse without it.
  const path = cachedLoginPath(ctx.env, ctx.home) ?? ctx.env.PATH;
  const bin = Bun.which(argv[0]!, { PATH: path ?? "" });
  if (!bin) return "unavailable";
  argv[0] = bin;
  const log = join(dir, `${nextLogIndex(dir)}.log`);
  try { closeSync(openSync(log, "a", 0o600)); } catch { /* a log that cannot be created never blocks a launch */ }
  const env = { ...plannerResumeEnv(ctx.env), ...(path ? { PATH: path } : {}), HOME: ctx.home, PACER_HOME: ctx.pacerHome, PACER_PLANNER_SESSION: `${reach.kind}:${session}`, PACER_CALLER_RESUME: deps.task };
  let pid: number | undefined, failure: unknown;
  try { pid = (deps.spawn ?? spawnResume)({ argv, cwd: reach.cwd, env, log }); } catch (e) { failure = e; }
  // No pid means nothing started: the record would be false and the ladder could not escalate.
  if (pid === undefined) {
    try { appendFileSync(log, `${failure === undefined ? "spawn returned no pid" : String(failure)}\n`); } catch { /* nothing left to report */ }
    return "unavailable";
  }
  const child = processIdentity(pid);
  if (child) try { writeFileSync(join(dir, "active.json"), JSON.stringify(child), { mode: 0o600 }); } catch { /* the lock is best effort */ }
  appendActivity(ctx, { kind: "message", level: "info", text: `caller resumed for ${deps.task}`, taskId: deps.task });
  return "resumed";
}
