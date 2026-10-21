import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { withLockSync } from "../core/lock";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../fsutil";
import type { Ctx, UsageWindow } from "../types";

const marksFile = (ctx: Ctx) => join(ctx.pacerHome, "exhausted.json");

export function readMarks(ctx: Ctx): Record<string, number> {
  return readJson<Record<string, number>>(marksFile(ctx)) ?? {};
}

/** Record that a provider hit a limit and is unusable until `until` (unix seconds). */
export function markExhausted(ctx: Ctx, id: string, until: number, options: { manual?: boolean; scope?: import("../evidence/types").EvidenceScope } = {}): void {
  withLockSync(ctx, "exhausted-evidence", () => {
    const marks = readMarks(ctx);
    marks[id] = until;
    writeJsonAtomic(marksFile(ctx), marks);
    const path = join(ctx.pacerHome, "state/exhausted-evidence.json");
    const evidence = readJson<Record<string, LimitObservation>>(path) ?? {};
    evidence[id] = { observedAt: ctx.now, until, manual: options.manual === true, ...(options.scope ? {scope: options.scope} : {}) };
    mkdirSync(join(ctx.pacerHome, "state"), { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(evidence), { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  });
}
export interface LimitObservation { scope?: import("../evidence/types").EvidenceScope; observedAt: number | null; until: number; manual: boolean }
export function limitObservation(ctx: Ctx, id: string): LimitObservation | null {
  const until = readMarks(ctx)[id];
  if (!until || until <= ctx.now) return null;
  const value = readJson<Record<string, LimitObservation>>(join(ctx.pacerHome, "state/exhausted-evidence.json"))?.[id];
  return value?.until === until ? value : { observedAt: null, until, manual: false };
}

/** A 100%-used window while a mark is active, else null. */
export function limitWindow(ctx: Ctx, id: string): UsageWindow | null {
  const until = readMarks(ctx)[id];
  if (!until || until <= ctx.now) return null;
  return { name: "limit", usedPct: 100, resetsAt: until, lengthS: Math.max(1, until - ctx.now), paced: false };
}
