import { autoCleanTask } from "../tasks/cleanup";
import type { Ctx } from "../types";

/** Native `task.dismiss` auto-clean side effects; Core remains authoritative. */
export async function taskAutoCleanBridge(ctx: Ctx, ids: string[]): Promise<{ ok: true }> {
  await Promise.all([...new Set(ids)].map(id => autoCleanTask(ctx, id)));
  return { ok: true };
}
