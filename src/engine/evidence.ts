import { createHash } from "node:crypto";
import type { AccountEvidence, Evidence, EvidenceScope, ReconciledEvidence } from "../evidence/types";
import type { UsageWindow } from "../types";

export const emptyEvidence = (): AccountEvidence => ({ availability: [], budget: [], spending: [] });
export function evidenceFact<T>(scope: EvidenceScope, source: Evidence<T>["source"], observedAt: number | null,
  validUntil: number | null, reason: string, value: T): Evidence<T> {
  const fact = { scope, source, observedAt, validUntil, reason, value };
  return { id: createHash("sha256").update(JSON.stringify(fact)).digest("hex").slice(0, 24), ...fact };
}
export function appliesTo(fact: Evidence<unknown>, scope: EvidenceScope): boolean {
  return fact.scope.account === scope.account && fact.scope.identity === scope.identity
    && (["runner", "model", "host"] as const).every(key => !fact.scope[key] || fact.scope[key] === scope[key]);
}
export function observationValid(fact: Evidence<unknown>, now: number): boolean {
  return fact.observedAt !== null && Number.isFinite(fact.observedAt) && fact.observedAt >= 0 && fact.observedAt <= now;
}
export function evidenceDeadline(fact: Evidence<UsageWindow>): number | null {
  if (fact.observedAt === null) return null;
  const age = fact.value.lengthS <= 6 * 3600 ? 7200 : 86400;
  return Math.min(fact.observedAt + age, fact.validUntil ?? Infinity, fact.value.resetsAt ?? Infinity);
}
export function currentEvidence(fact: Evidence<unknown>, now: number, deadline = fact.validUntil): boolean {
  return observationValid(fact, now) && (deadline === null || deadline > now);
}
const precedence = (source: Evidence<unknown>["source"]) => source === "configuration" ? 3 : source === "provider-cli" ? 2 : 1;

/** Retain the latest observation of each fact, including equal-authority conflicts. */
export function reconcileEvidence(previous: AccountEvidence, incoming: AccountEvidence, now: number): ReconciledEvidence {
  const facts = emptyEvidence(), conflicts: string[] = [];
  for (const kind of ["availability", "budget", "spending"] as const) {
    const groups = new Map<string, Evidence<unknown>[]>();
    for (const fact of [...previous[kind], ...incoming[kind]]) {
      const key = JSON.stringify([fact.scope.account, fact.scope.identity, fact.scope.runner, fact.scope.model, fact.scope.host,
        kind === "budget" ? (fact.value as UsageWindow).name : kind]);
      const values = groups.get(key) ?? [];
      values.push(fact); groups.set(key, values);
    }
    for (const values of groups.values()) {
      const valid = values.filter(f => observationValid(f, now));
      const candidates = valid.length ? valid : values;
      const newest = Math.max(...candidates.map(f => observationValid(f, now) ? f.observedAt! : -Infinity));
      const contemporaries = candidates.filter(f => (observationValid(f, now) ? f.observedAt! : -Infinity) === newest);
      const priority = Math.max(...contemporaries.map(f => precedence(f.source)));
      const peers = contemporaries.filter(f => precedence(f.source) === priority);
      const unique = [...new Map(peers.map(f => [JSON.stringify([f.value, f.validUntil]), f])).values()];
      if (unique.length > 1) conflicts.push(...unique.map(f => f.id));
      (facts[kind] as Evidence<unknown>[]).push(...unique);
    }
    facts[kind].sort((a, b) => a.id.localeCompare(b.id));
  }
  return { facts, conflicts: conflicts.sort() };
}
