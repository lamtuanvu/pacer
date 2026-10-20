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
  if (fact.source === "configuration") return fact.validUntil ?? fact.value.resetsAt;
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
  }
  const measured = facts.budget.filter(f => f.source !== "execution" && f.source !== "configuration" && f.value.name !== "limit");
  if (measured.length && measured.every(f => currentEvidence(f, now, evidenceDeadline(f)) && f.value.usedPct !== null && f.value.usedPct < 97)) {
    facts.budget = facts.budget.filter(f => f.source !== "execution" || f.value.name !== "limit"
      || !measured.every(sample => sample.observedAt! > (f.observedAt ?? Infinity) && appliesTo(sample, f.scope)));
  }
  return { facts, conflicts: conflicts.filter(id => [...facts.availability, ...facts.budget, ...facts.spending].some(f => f.id === id)).sort() };
}

/** Adapter facts are normalized without deciding whether a launch is allowed. */
export function readingEvidence(scope: EvidenceScope, reading: import("../types").UsageReading,
  usage: import("../types").UsageKind): AccountEvidence {
  if (reading.evidence) return reading.evidence;
  const facts = emptyEvidence();
  const source = reading.source ?? "session-log";
  const contract = usage === "reactive" || usage === "unmetered";
  for (const window of reading.windows) {
    if (contract && window.name === "limit" && window.usedPct === 0) continue;
    facts.budget.push(evidenceFact(scope, source, reading.capturedAt, null, "quota_observed", window));
  }
  const availability = reading.availability;
  if (availability) facts.availability.push(evidenceFact(scope, source, reading.capturedAt, availability.validUntil, availability.reason, availability.state));
  else if (contract) facts.availability.push(evidenceFact(scope, "configuration", 0, null, "measurement_contract", "ready"));
  else if (facts.budget.length && !reading.error && !reading.stale) {
    const deadlines = facts.budget.map(evidenceDeadline).filter((at): at is number => at !== null);
    facts.availability.push(evidenceFact(scope, source, reading.capturedAt,
      deadlines.length ? Math.min(...deadlines) : null, "usage_observed", "ready"));
  }
  if (reading.spending) facts.spending.push(evidenceFact(scope, source, reading.capturedAt,
    reading.capturedAt === null ? null : reading.capturedAt + 7200, "spending_observed", reading.spending));
  for (const alternative of reading.alternatives ?? []) {
    const other = readingEvidence(scope, alternative, usage);
    facts.availability.push(...other.availability); facts.budget.push(...other.budget); facts.spending.push(...other.spending);
  }
  return facts;
}
