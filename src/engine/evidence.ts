import { createHash } from "node:crypto";
import type { AccountEvidence, Evidence, EvidenceScope, ReconciledEvidence } from "../evidence/types";
import type { UsageWindow } from "../types";
import { EXHAUSTED_PCT } from "./verdict";

export const emptyEvidence = (): AccountEvidence => ({ availability: [], budget: [], spending: [] });
export function evidenceFact<T>(scope: EvidenceScope, source: Evidence<T>["source"], observedAt: number | null,
  validUntil: number | null, reason: string, value: T, budgetPolicy?: string): Evidence<T> {
  const fact = { scope, source, observedAt, validUntil, reason, value, ...(budgetPolicy !== undefined ? {budgetPolicy} : {}) };
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
  // Configuration and execution cooldown marks bind until their stated end, not the
  // short-window freshness cap used for measured quota observations.
  if (fact.source === "configuration" || (fact.source === "execution" && fact.value.name === "limit")) {
    return fact.validUntil ?? fact.value.resetsAt;
  }
  const age = fact.value.lengthS <= 6 * 3600 ? 7200 : 86400;
  return Math.min(fact.observedAt + age, fact.validUntil ?? Infinity, fact.value.resetsAt ?? Infinity);
}
export function currentEvidence(fact: Evidence<unknown>, now: number, deadline = fact.validUntil): boolean {
  return observationValid(fact, now) && (deadline === null || deadline > now);
}
const precedence = (source: Evidence<unknown>["source"]) => source === "configuration" ? 3 : source === "provider-cli" ? 2 : 1;

/** A window with a positive, finite duration is a usable quota constraint. */
function windowUsable(w: UsageWindow): boolean {
  return Number.isFinite(w.lengthS) && w.lengthS > 0;
}

/** A measured quota observation from a provider polling source (not config/execution/manual). */
function measuredQuota(f: Evidence<UsageWindow>): boolean {
  return f.reason === "quota_observed" && (f.source === "session-log" || f.source === "provider-cli");
}

/**
 * Narrowly identify invalid zero-duration Codex quota artifacts (historical 0h
 * windows created before the parser guard) that a fresher, still-current,
 * known-percentage measurement of the same account safely supersedes. Only
 * measured session-log/provider-cli quota_observed facts named 0h with exactly zero duration
 * are candidates; such an artifact is retired when a strictly newer,
 * currently-valid witness shares its account/identity, covers its scope
 * (a narrower witness cannot clear a broader artifact), and carries the same
 * budget policy. Genuine positive-duration windows (expired, unknown or
 * exhausted) and configuration/execution/manual or metered boundaries are never
 * touched here; omission of a window alone never proves recovery.
 */
function retireInvalidZero(budget: Evidence<UsageWindow>[], now: number): Set<string> {
  const witnesses = budget.filter(f => measuredQuota(f) && windowUsable(f.value) && !f.value.stale
    && typeof f.value.usedPct === "number" && Number.isFinite(f.value.usedPct)
    && f.value.usedPct >= 0 && f.value.usedPct <= 100
    && f.observedAt !== null && currentEvidence(f, now, evidenceDeadline(f)));
  const retired = new Set<string>();
  for (const f of budget) {
    if (!measuredQuota(f)) continue;      // configuration / execution / metered boundaries preserved
    if (f.value.name !== "0h" || f.value.lengthS !== 0) continue; // only the historical artifact
    if (f.observedAt === null) continue;  // cannot prove a fresh recovery over it
    if (witnesses.some(w => w.observedAt! > f.observedAt! && appliesTo(w, f.scope)
      && w.budgetPolicy === f.budgetPolicy)) retired.add(f.id);
  }
  return retired;
}

/** Retain the latest observation of each fact, including equal-authority conflicts. */
export function reconcileEvidence(previous: AccountEvidence, incoming: AccountEvidence, now: number, budgetPolicy?: string): ReconciledEvidence {
  const facts = emptyEvidence(), conflicts: string[] = [];
  // Retire invalid zero-duration measured artifacts across BOTH previous and
  // incoming candidates so a cached historical alternative cannot reintroduce a
  // retired fact on the next poll.
  const retired = retireInvalidZero([...previous.budget, ...incoming.budget], now);
  const previousBudget = previous.budget.filter(f => !retired.has(f.id));
  const incomingBudget = incoming.budget.filter(f => !retired.has(f.id));
  for (const kind of ["availability", "budget", "spending"] as const) {
    const groups = new Map<string, Evidence<unknown>[]>();
    for (const fact of [...(kind === "budget" ? previousBudget : previous[kind]), ...(kind === "budget" ? incomingBudget : incoming[kind])]) {
      const key = JSON.stringify([fact.scope.account, fact.scope.identity, fact.scope.runner, fact.scope.model, fact.scope.host,
        kind === "budget" ? [(fact.value as UsageWindow).name, fact.budgetPolicy] : kind]);
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
  const measured = facts.budget.filter(f => f.source !== "execution" && f.source !== "configuration" && f.value.name !== "limit"
    && (f.source !== "metered" || budgetPolicy === undefined || f.budgetPolicy === budgetPolicy));
  if (measured.length && measured.every(f => currentEvidence(f, now, evidenceDeadline(f)) && f.value.usedPct !== null && f.value.usedPct < 97)) {
    facts.budget = facts.budget.filter(f => f.source !== "execution" || f.value.name !== "limit"
      || !measured.every(sample => sample.observedAt! > (f.observedAt ?? Infinity) && appliesTo(sample, f.scope)));
  }
  // Cooldown marks (execution and manual configuration limits) stop constraining once
  // their stated end passes. Expired peers otherwise mark the reading stale forever.
  facts.budget = facts.budget.filter(f => {
    if ((f.source !== "execution" && f.source !== "configuration") || f.value.name !== "limit") return true;
    const until = f.validUntil ?? f.value.resetsAt;
    return observationValid(f, now) && (until === null || until > now);
  });
  // A newer valid read from the same source that omits a window retires that source's unknown
  // or lapsed fact for it. Live measured windows, exhaustion before its reset, other sources
  // and limit marks are kept.
  const reported = new Set(incoming.budget.map(f => f.value.name));
  const witnesses = incoming.budget.filter(g => observationValid(g, now) && !g.value.stale && typeof g.value.usedPct === "number"
    && Number.isFinite(g.value.usedPct) && g.value.usedPct >= 0 && g.value.usedPct <= 100);
  const kept = (f: Evidence<UsageWindow>) => f.value.name === "limit" || reported.has(f.value.name) || f.observedAt === null
    || (f.value.usedPct !== null && currentEvidence(f, now, evidenceDeadline(f)))
    || (f.value.usedPct !== null && f.value.usedPct >= EXHAUSTED_PCT && (f.value.resetsAt === null || f.value.resetsAt > now));
  facts.budget = facts.budget.filter(f => kept(f)
    || !witnesses.some(g => g.source === f.source && appliesTo(g, f.scope) && g.observedAt! > f.observedAt!));
  const retained = [...facts.availability, ...facts.budget, ...facts.spending];
  return { facts, conflicts: conflicts.filter(id => retained.some(f => f.id === id)).sort() };
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
  else if ((facts.budget.length || reading.spendUsd != null) && !reading.error && !reading.stale) {
    const deadlines = facts.budget.map(evidenceDeadline).filter((at): at is number => at !== null);
    facts.availability.push(evidenceFact(scope, source, reading.capturedAt,
      deadlines.length ? Math.min(...deadlines) : reading.capturedAt === null ? null : reading.capturedAt + 86400, "usage_observed", "ready"));
  }
  if (reading.spending) facts.spending.push(evidenceFact(scope, source, reading.capturedAt,
    reading.capturedAt === null ? null : reading.capturedAt + 7200, "spending_observed", reading.spending));
  for (const alternative of reading.alternatives ?? []) {
    const other = readingEvidence(scope, alternative, usage);
    facts.availability.push(...other.availability); facts.budget.push(...other.budget); facts.spending.push(...other.spending);
  }
  return facts;
}
