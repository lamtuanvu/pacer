import { CoreError } from "../core/errors";
/** Delegation admission saw another task change while it was deciding (the
 *  planner's turn is live while an accept advances the run, say): nothing was
 *  committed, so the same delegation can simply be made again. */
export function isAdmissionRace(err: unknown): boolean {
  return err instanceof CoreError && err.code === "conflict" && err.message.includes("Policy context changed");
}

/** SQLite lock contention (SQLITE_BUSY and its messages, including the busy-timeout
 *  expiry) is transient: callers retry on the next tick instead of failing a run
 *  over a lock another connection still holds. */
export function isTransientError(err: unknown): boolean {
  if (isAdmissionRace(err)) return true;
  const text = `${err instanceof Error ? err.message : String(err)}`.toLowerCase();
  return text.includes("sqlite_busy") || text.includes("database is locked")
    || text.includes("database table is locked") || text.includes("database is busy")
    || text.includes("database schema is locked");
}
