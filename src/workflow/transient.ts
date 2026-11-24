/** SQLite lock contention (SQLITE_BUSY and its messages, including the busy-timeout
 *  expiry) is transient: callers retry on the next tick instead of failing a run
 *  over a lock another connection still holds. */
export function isTransientError(err: unknown): boolean {
  const text = `${err instanceof Error ? err.message : String(err)}`.toLowerCase();
  return text.includes("sqlite_busy") || text.includes("database is locked")
    || text.includes("database table is locked") || text.includes("database is busy")
    || text.includes("database schema is locked");
}
