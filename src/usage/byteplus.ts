import type { Ctx, UsageReading } from "../types";

/** Same wall-clock instant one calendar month earlier (UTC), clamped to month end. */
export function monthBefore(ts: number): number {
  const d = new Date(ts * 1000);
  const t = new Date(d.getTime());
  t.setUTCMonth(d.getUTCMonth() - 1);
  if (t.getUTCDate() !== d.getUTCDate()) t.setUTCDate(0);
  return t.getTime() / 1000;
}

export async function readByteplus(ctx: Ctx, refresh = false): Promise<UsageReading> {
  return (await import("./plugin-readers")).readQuotaPlugin(ctx, "arkcli", undefined, refresh);
}
