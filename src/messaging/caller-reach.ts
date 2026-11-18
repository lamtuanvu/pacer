import { processIdentity, sameProcess, type ProcessIdentity } from "../update/desktop/process-identity";
import type { Ctx } from "../types";

export type TerminalReach = { kind: "orca"; handle: string; paneKey?: string } | { kind: "tmux"; pane: string } | { kind: "uncontrolled" };

/**
 * Where the caller can be reached again when it owes a decision: a delivery hint recorded at delegate,
 * never identity (ADR 0011 still derives the participant) and never taken from request params.
 */
export interface CallerReach { participant: string; session?: string; process?: ProcessIdentity; cwd: string; terminal: TerminalReach; at: number }

/** The caller's reach from its own environment, or null for human and executor callers. */
export function callerReach(ctx: Ctx, participant: string): CallerReach | null {
  if (participant === "human" || participant.startsWith("task:")) return null;
  const env = ctx.env;
  const session = env.CLAUDE_CODE_SESSION_ID?.trim() || env.PACER_PLANNER_SESSION?.trim() || env.CODEX_THREAD_ID?.trim();
  const handle = env.ORCA_TERMINAL_HANDLE?.trim(), tmux = env.TMUX_PANE?.trim(), paneKey = env.ORCA_PANE_KEY?.trim();
  const identity = processIdentity(Number(env.CLAUDE_PID?.trim()) || process.ppid);
  const terminal: TerminalReach = handle ? { kind: "orca", handle, ...(paneKey ? { paneKey } : {}) }
    : tmux ? { kind: "tmux", pane: tmux } : { kind: "uncontrolled" };
  return { participant, ...(session ? { session } : {}), ...(identity ? { process: identity } : {}), cwd: process.cwd(), terminal, at: ctx.now };
}

/** Whether the recorded caller process is still the recorded one: a live but reused pid is not the caller. */
export function callerAlive(ctx: Ctx, reach: CallerReach): Promise<boolean> {
  const want = reach.process;
  return Promise.resolve(!!want && sameProcess(processIdentity(want.pid), want));
}
