import { currentSnapshot, readOutboxSince } from "../link/store";
import type { LinkSnapshot } from "../link/envelope";
import type { Ctx } from "../types";
import { type ApiEvent, PROTOCOL_VERSION } from "./protocol";

export function apiSnapshot(ctx: Ctx): { protocol: string; seq: number; snapshot: LinkSnapshot } {
  const snapshot = currentSnapshot(ctx);
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
