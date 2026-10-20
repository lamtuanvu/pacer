import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../fsutil";
import type { Ctx, UsageReading } from "../types";

const authFile = (ctx: Ctx) => join(ctx.pacerHome, "state", "auth-failed.json");
const authError = /not logged in|please log in|401|unauthorized|authentication/i;
/** Attempt output is mostly the agent's own work, which may mention auth; match only CLI login failures. */
export const attemptAuthError = /not logged in|please (?:log|sign) in|login required|401 unauthorized|invalid api key|authentication (?:failed|required)/i;

export function readAuthFailures(ctx: Ctx): Record<string, number> {
  return readJson<Record<string, number>>(authFile(ctx)) ?? {};
}

/** Only authentication errors change sign-in state; transient failures leave it alone. */
export function markAuthFailed(ctx: Ctx, account: string, text: string, o: {attempt?: boolean} = {}): void {
  if (!(o.attempt ? attemptAuthError : authError).test(text)) return;
  const marks = readAuthFailures(ctx);
  marks[account] = ctx.now;
  writeJsonAtomic(authFile(ctx), marks);
}

/** Call for a newly fetched reading, never a cached success from before an attempt. */
export function recordAuthReading(ctx: Ctx, account: string, reading: UsageReading): void {
  if (reading.error) { markAuthFailed(ctx, account, reading.error); return; }
  if (reading.stale || reading.capturedAt === null || reading.capturedAt > ctx.now || reading.source === "reactive" || reading.source === "unmetered") return;
  const marks = readAuthFailures(ctx);
  if (!Object.hasOwn(marks, account) || reading.capturedAt <= marks[account]) return;
  delete marks[account];
  writeJsonAtomic(authFile(ctx), marks);
}
