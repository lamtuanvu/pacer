type Cleanup = () => void | Promise<void>;
const pending: Cleanup[] = [];

/** Register only resources created by the current test, independent of import scope. */
export function registerFixtureCleanup(cleanup: Cleanup): void {
  pending.push(cleanup);
}

/** The global preload calls this after each test; one failure cannot skip other owners. */
export async function cleanupFixtureResources(): Promise<void> {
  const failures: unknown[] = [];
  for (const cleanup of pending.splice(0)) {
    try { await cleanup(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Owned test fixture cleanup failed");
}
