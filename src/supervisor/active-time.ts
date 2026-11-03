import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunState } from "./run";

export function inputWaitStartedAt(state: RunState, now: number): number | null {
  if (!state.interactive) return null;
  if ((state.report?.status === "needs-input" || state.report?.status === "turn-ended") &&
    !(state.lastInputAt && state.lastInputAt > state.report.at)) return Math.min(now, state.report.at * 1000);
  // A controller lease must never backdate to an unrelated old running report.
  return state.controller ? now : null;
}

interface Budget { base: number; deadline: number; waitingSince: number | null }
/** Persist per-attempt wait accounting so reattachment cannot charge past input waits as execution. */
export function activeDeadlineExpired(dir: string, base: number, state: RunState, now = Date.now()): boolean {
  const file = join(dir, "active-time.json");
  let budget: Budget = {base, deadline: base, waitingSince: null};
  try {
    const saved = JSON.parse(readFileSync(file, "utf8"));
    if (saved.base === base && Number.isFinite(saved.deadline) &&
      (saved.waitingSince === null || Number.isFinite(saved.waitingSince))) budget = saved;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const waitAt = inputWaitStartedAt(state, now);
  const waiting = waitAt !== null;
  const previous = JSON.stringify(budget);
  if (waiting) budget.waitingSince ??= waitAt;
  else if (budget.waitingSince !== null) {
    const resumed = [state.report?.status === "running" ? state.report.at * 1000 : undefined,
      state.lastInputAt ? state.lastInputAt * 1000 : undefined]
      .filter((at): at is number => at !== undefined && at >= budget.waitingSince! && at <= now);
    budget.deadline += Math.max(0, (resumed.length ? Math.min(...resumed) : now) - budget.waitingSince);
    budget.waitingSince = null;
  }
  if (JSON.stringify(budget) !== previous) {
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(budget), {flag: "wx", mode: 0o600});
    renameSync(temporary, file);
  }
  return !waiting && now >= budget.deadline;
}
