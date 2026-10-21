import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { AccountEvidence, EvidenceScope, ReconciledEvidence } from "../evidence/types";
import { emptyEvidence, evidenceFact, reconcileEvidence } from "../engine/evidence";
import { readJson } from "../fsutil";
import type { Ctx } from "../types";
import { withLock, withLockSync } from "./lock";

export interface EvidenceSnapshot { retiredAt?: number; version: 1; revision: number; identity: string; evidence: ReconciledEvidence }
export { accountEvidenceScope } from "../evidence/scope";
function evidencePath(ctx: Ctx, scope: EvidenceScope): string {
  if (!/^[a-f0-9]{64}$/.test(scope.identity)) throw Error("invalid evidence identity");
  return join(ctx.pacerHome, "state/evidence", `${scope.identity}.json`);
}
export function readEvidence(ctx: Ctx, scope: EvidenceScope): EvidenceSnapshot {
  const empty: EvidenceSnapshot = { version: 1, revision: 0, identity: scope.identity, evidence: { facts: emptyEvidence(), conflicts: [] } };
  const saved = readJson<EvidenceSnapshot>(evidencePath(ctx, scope));
  if (!saved || saved.version !== 1 || saved.identity !== scope.identity || !Number.isSafeInteger(saved.revision)
    || saved.revision < 0 || !saved.evidence || !Array.isArray(saved.evidence.conflicts)) return empty;
  const facts = saved.evidence.facts;
  if (!facts || ![facts.availability, facts.budget, facts.spending].every(values => Array.isArray(values)
    && values.every(f => f && typeof f.id === "string" && f.scope?.identity === scope.identity
      && f.scope?.account === scope.account && typeof f.source === "string" && typeof f.reason === "string"
      && (f.observedAt === null || Number.isFinite(f.observedAt)) && (f.validUntil === null || Number.isFinite(f.validUntil))))) return empty;
  if (!facts.availability.every(f => ["ready", "unavailable", "unknown"].includes(f.value))
    || !facts.budget.every(({ value: w }) => w && typeof w.name === "string"
      && (w.usedPct === null || Number.isFinite(w.usedPct) && w.usedPct >= 0)
      && (w.resetsAt === null || Number.isFinite(w.resetsAt))
      && Number.isFinite(w.lengthS) && w.lengthS >= 0 && typeof w.paced === "boolean")
    || !facts.spending.every(({ value: v }) => v && ["observed", "unknown", "not_observed"].includes(v.paidConsumption)
      && (v.creditsAvailable === null || typeof v.creditsAvailable === "boolean")
      && (v.creditBalance === null || Number.isFinite(v.creditBalance)))) return empty;
  return saved;
}
export const evidenceRevision = (ctx: Ctx, scope: EvidenceScope): number => readEvidence(ctx, scope).revision;
export async function mergeEvidence(ctx: Ctx, scope: EvidenceScope, incoming: AccountEvidence, budgetPolicy?: string): Promise<EvidenceSnapshot> {
  const merge = async () => {
    const previous = readEvidence(ctx, scope);
    const accepted = emptyEvidence();
    for (const kind of ["availability", "budget", "spending"] as const) {
      (accepted[kind] as import("../evidence/types").Evidence<unknown>[]).push(...incoming[kind].filter(f => previous.retiredAt === undefined || f.source === "configuration" || f.observedAt !== null && f.observedAt > previous.retiredAt));
    }
    const evidence = reconcileEvidence(previous.evidence.facts, accepted, ctx.now, budgetPolicy);
    if (JSON.stringify(evidence) === JSON.stringify(previous.evidence)) return previous;
    const next: EvidenceSnapshot = { ...(previous.retiredAt !== undefined ? {retiredAt: previous.retiredAt} : {}), version: 1, revision: previous.revision + 1, identity: scope.identity, evidence };
    if (!ctx.readOnly) {
      const dir = join(ctx.pacerHome, "state/evidence");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = evidencePath(ctx, scope), temp = `${path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temp, JSON.stringify(next), { flag: "wx", mode: 0o600 });
        renameSync(temp, path);
      } finally { try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
    }
    return next;
  };
  return ctx.readOnly ? merge() : withLock(ctx, `evidence-${scope.identity}`, merge);
}

export async function recordExecutionEvidence(ctx: Ctx, scope: EvidenceScope, result: {
  endedAt: number; exitCode: number; timedOut: boolean;
  classification: "success" | "quota" | "authentication" | "subscription" | "transient" | "task"; until?: number;
}): Promise<EvidenceSnapshot> {
  const facts = emptyEvidence();
  if (result.timedOut || result.classification === "task" || result.classification === "transient") return readEvidence(ctx, scope);
  const until = result.until ?? result.endedAt + 7200;
  if (result.classification === "quota") {
    facts.budget.push(evidenceFact(scope, "execution", result.endedAt, until, "quota_failure",
      { name: "limit", usedPct: 100, resetsAt: until, lengthS: 21600, paced: false }));
  } else {
    facts.availability.push(evidenceFact(scope, "execution", result.endedAt, until,
      result.classification === "success" ? "execution_success" : `${result.classification}_failed`,
      result.classification === "success" ? "ready" : "unavailable"));
  }
  return mergeEvidence(ctx, scope, facts);
}

/** Preserve a lifetime boundary so delayed reads cannot repopulate a removed account. */
export function retireEvidence(ctx: Ctx, scope: EvidenceScope): void {
 if (ctx.readOnly) return;
 withLockSync(ctx, `evidence-${scope.identity}`, () => {
  const previous=readEvidence(ctx,scope),path=evidencePath(ctx,scope),temp=`${path}.${randomUUID()}.tmp`;
  mkdirSync(join(ctx.pacerHome,"state/evidence"),{recursive:true,mode:0o700});
  const next:EvidenceSnapshot={version:1,identity:scope.identity,revision:previous.revision+1,retiredAt:Math.max(ctx.now,previous.retiredAt??0),evidence:{facts:emptyEvidence(),conflicts:[]}};
  try {writeFileSync(temp,JSON.stringify(next),{flag:"wx",mode:0o600});renameSync(temp,path);}
  finally {try {unlinkSync(temp);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}}
 });
}
