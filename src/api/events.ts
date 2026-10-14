import { currentSnapshot, readOutboxSince } from "../link/store";
import type { LinkSnapshot } from "../link/envelope";
import { toBudget } from "../link/budget";
import { taskData } from "../link/pump";
import { listTasks } from "../tasks/store";
import { taskStatus } from "../tasks/api";
import { computeStatus, type Status } from "../engine/status";
import { loadStrategy } from "../config/strategy";
import type { Ctx } from "../types";
import { type ApiEvent, PROTOCOL_VERSION } from "./protocol";

export function apiSnapshot(ctx: Ctx): { protocol: string; seq: number; snapshot: LinkSnapshot } {
  const snapshot = currentSnapshot(ctx);
  return { protocol: PROTOCOL_VERSION, seq: snapshot.seq, snapshot };
}

export async function liveSnapshot(
  ctx: Ctx, o: { maxBudgetAgeS?: number; status?: (c: Ctx) => Promise<Status> } = {},
): Promise<{ protocol: string; seq: number; snapshot: LinkSnapshot }> {
  const snapshot = currentSnapshot(ctx);
  snapshot.tasks = listTasks(ctx, 20).map(t => ({
    ...snapshot.tasks.find(old => old.id === t.id),
    ...taskData(taskStatus(ctx, t.id) ?? t),
  }));
  if (!snapshot.budget || ctx.now - snapshot.budget.generatedAt > (o.maxBudgetAgeS ?? 60)) {
    try {
      const status = o.status ?? (c => computeStatus({ ...c, readOnly: true }, loadStrategy(c)));
      snapshot.budget = toBudget(await status(ctx));
    } catch { /* Keep the stored budget when status cannot be refreshed. */ }
  }
  return { protocol: PROTOCOL_VERSION, seq: snapshot.seq, snapshot };
}

export function eventsSince(ctx: Ctx, since: number): { events: ApiEvent[]; last: number; reset: boolean } {
  const all = readOutboxSince(ctx, 0);
  const oldest = all[0]?.seq;
  const reset = since > 0 && oldest !== undefined && oldest > since + 1;
  const after = all.filter((e) => e.seq > since);
  const events: ApiEvent[] = [
    ...(reset ? [{ seq: oldest! - 1, at: ctx.now, type: "reset" as const, data: { reason: "events were dropped; fetch the snapshot again" } }] : []),
    ...after.map((e) => ({ seq: e.seq, at: ctx.now, type: e.envelope.type, data: e.envelope.data })),
  ];
  return { events, last: after.at(-1)?.seq ?? since, reset };
}
