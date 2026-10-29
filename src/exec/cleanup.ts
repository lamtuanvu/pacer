import type { TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";

export interface HostCleanOpts { dryRun?: boolean; force?: boolean; shared: (path: string) => boolean }
/** null: no execution host owns the task's worktree (pacer's own cleanup applies); gone: nothing left to remove. */
export type HostClean = { removed: true } | { kept: string } | { gone: true } | null;

interface HostCleaner {
  clean(ctx: Ctx, t: TaskRecord, o: HostCleanOpts): Promise<HostClean>;
  reconcile(ctx: Ctx): Promise<void>;
}

// Loaded on use: host adapters depend on the task store and backends, which import the core.
const HOSTS: (() => Promise<HostCleaner>)[] = [
  async () => { const m = await import("./orca/cleanup"); return { clean: m.cleanOrcaTask, reconcile: m.reconcileOrcaWork }; },
];

/** Remove worktrees an execution host created for a settled, reviewed task. Hosts verify ownership. */
export async function cleanHostWorktree(ctx: Ctx, t: TaskRecord, o: HostCleanOpts): Promise<HostClean> {
  for (const host of HOSTS) {
    const r = await (await host()).clean(ctx, t, o);
    if (r) return r;
  }
  return null;
}

/** Retry host resources left by uncertain starts. Never throws. */
export async function reconcileHostWork(ctx: Ctx): Promise<void> {
  for (const host of HOSTS) {
    try { await (await host()).reconcile(ctx); } catch { /* A later pass retries. */ }
  }
}
