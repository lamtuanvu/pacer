import { processIdentity, sameProcess, type ProcessIdentity } from "../update/desktop/process-identity";
import type { Ctx } from "../types";

export type TerminalReach = { kind: "orca"; handle: string; paneKey?: string } | { kind: "tmux"; pane: string } | { kind: "uncontrolled" };

/**
 * Where the caller can be reached again when it owes a decision: a delivery hint recorded at delegate,
 * never identity (ADR 0011 still derives the participant) and never taken from request params.
 */
export interface CallerReach { participant: string; session?: string; process?: ProcessIdentity; cwd: string; terminal: TerminalReach; at: number }

/** The caller's reach from its own environment, or null for human and executor callers.
 * Only records in the caller's own process: never the service's env over HTTP. */
export function callerReach(ctx: Ctx, participant: string): CallerReach | null {
  if (participant === "human" || participant.startsWith("task:")) return null;
  const env = ctx.env;
  const session = env.CLAUDE_CODE_SESSION_ID?.trim() || env.PACER_PLANNER_SESSION?.trim() || env.CODEX_THREAD_ID?.trim();
  const handle = env.ORCA_TERMINAL_HANDLE?.trim(), tmux = env.TMUX_PANE?.trim(), paneKey = env.ORCA_PANE_KEY?.trim();
  // The planner's own pid only: a shell parent dies at once and would read as a closed session.
  const pid = Number(env.CLAUDE_PID?.trim());
  const identity = Number.isSafeInteger(pid) && pid > 0 ? processIdentity(pid) : null;
  const terminal: TerminalReach = handle ? { kind: "orca", handle, ...(paneKey ? { paneKey } : {}) }
    : tmux ? { kind: "tmux", pane: tmux } : { kind: "uncontrolled" };
  return { participant, ...(session ? { session } : {}), ...(identity ? { process: identity } : {}), cwd: process.cwd(), terminal, at: ctx.now };
}

/** Whether the recorded caller process is still the recorded one: a live but reused pid is not the caller.
 * `unknown` when no process was recorded or it cannot be read: the caller ladder must not resume on it. */
export function callerAlive(ctx: Ctx, reach: CallerReach): Promise<"alive" | "gone" | "unknown"> {
  const want = reach.process;
  if (!want) return Promise.resolve("unknown");
  const now = processIdentity(want.pid);
  if (!now) return Promise.resolve("unknown");
  return Promise.resolve(sameProcess(now, want) ? "alive" : "gone");
}
