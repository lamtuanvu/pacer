import { readEvidence } from "../core/evidence";
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../fsutil";
import type { EvidenceScope } from "../evidence/types";
import type { Ctx, UsageReading } from "../types";

const authFile = (ctx: Ctx) => join(ctx.pacerHome, "state", "auth-failed.json");
const authError = /not logged in|please log in|401|unauthorized|authentication/i;
/** Attempt output is mostly the agent's own work, which may mention auth; match only CLI login failures. */
export const attemptAuthError = /not logged in|please (?:log|sign) in|login required|401 unauthorized|invalid api key|authentication (?:failed|required)/i;

export function readAuthFailures(ctx: Ctx): Record<string, number> {
  return readJson<Record<string, number>>(authFile(ctx)) ?? {};
}

/** Only authentication errors change sign-in state; transient failures leave it alone. */
export function markAuthFailed(ctx: Ctx, account: string, text: string, o: {attempt?: boolean; scope?: EvidenceScope} = {}): void {
  if (!(o.attempt ? attemptAuthError : authError).test(text)) return;
  const marks = readAuthFailures(ctx);
  marks[account] = ctx.now;
  writeJsonAtomic(authFile(ctx), marks);
  const path = join(ctx.pacerHome, "state/auth-evidence.json");
  const evidence = readJson<Record<string, {at: number; scope?: EvidenceScope}>>(path) ?? {};
  evidence[account] = {at: ctx.now, scope: o.scope};
  mkdirSync(join(ctx.pacerHome, "state"), {recursive:true,mode:0o700});
  const temp=`${path}.${randomUUID()}.tmp`;
  writeFileSync(temp,JSON.stringify(evidence),{flag:"wx",mode:0o600});renameSync(temp,path);
}

/** Call for a newly fetched reading, never a cached success from before an attempt. */
export function recordAuthReading(ctx: Ctx, account: string, reading: UsageReading, scope?: EvidenceScope): void {
  if (reading.error) { markAuthFailed(ctx, account, reading.error, {scope}); return; }
  if (reading.stale || reading.capturedAt === null || reading.capturedAt > ctx.now || reading.source === "reactive" || reading.source === "unmetered") return;
  const marks = readAuthFailures(ctx);
  if (!Object.hasOwn(marks, account) || reading.capturedAt <= marks[account]) return;
  delete marks[account];
  writeJsonAtomic(authFile(ctx), marks);
}

/** Legacy name-only marks are history, not current identity evidence. */
export function authObservation(ctx: Ctx, scope: EvidenceScope): {at: number; scope: EvidenceScope} | null {
 const value=readJson<Record<string,{at:number;scope?:EvidenceScope}>>(join(ctx.pacerHome,"state/auth-evidence.json"))?.[scope.account];
 return value?.scope?.identity===scope.identity && value.at===readAuthFailures(ctx)[scope.account] && Number.isFinite(value.at) && value.at<=ctx.now && value.at>(readEvidence(ctx,scope).retiredAt??-1) ? {at:value.at,scope:value.scope} : null;
}

export function accountAuthFailure(ctx: Ctx, scope: EvidenceScope): boolean {
 const observation=authObservation(ctx,scope);
 return !!observation && observation.at+7200>ctx.now && !observation.scope.runner && !observation.scope.model && !observation.scope.host;
}
