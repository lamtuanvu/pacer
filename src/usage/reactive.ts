import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../fsutil";
import type { Ctx, UsageWindow } from "../types";

const marksFile = (ctx: Ctx) => join(ctx.pacerHome, "exhausted.json");

export function readMarks(ctx: Ctx): Record<string, number> {
  return readJson<Record<string, number>>(marksFile(ctx)) ?? {};
}

/** Record that a provider hit a limit and is unusable until `until` (unix seconds). */
export function markExhausted(ctx: Ctx, id: string, until: number): void {
  const marks = readMarks(ctx);
  marks[id] = until;
  writeJsonAtomic(marksFile(ctx), marks);
}

/** A 100%-used window while a mark is active, else null. */
export function limitWindow(ctx: Ctx, id: string): UsageWindow | null {
  const until = readMarks(ctx)[id];
  if (!until || until <= ctx.now) return null;
  return { name: "limit", usedPct: 100, resetsAt: until, lengthS: Math.max(1, until - ctx.now), paced: false };
}
