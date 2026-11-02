import { expect, test } from "bun:test";
import { emptyEvidence, evidenceFact, reconcileEvidence } from "../src/engine/evidence";
import type { EvidenceScope, AccountEvidence } from "../src/evidence/types";
import { evaluateEligibility } from "../src/engine/eligibility";

const now = 1_000_000;
const scope: EvidenceScope = { account: "one", identity: "one" };

function zeroDurationWindow(observedAt = now - 86400): AccountEvidence {
  // A historical Codex snapshot whose window_minutes was 0 produced an invalid 0h artifact.
  return { ...emptyEvidence(), budget: [evidenceFact(scope, "session-log", observedAt, null, "quota_observed",
    { name: "0h", usedPct: null, resetsAt: null, lengthS: 0, paced: false })] };
}
function freshQuota(usedPct: number, name = "weekly", observedAt = now, lengthS = 604800): AccountEvidence {
  // A trustworthy fresh provider read (the read-only app-server poll) still reports the real window
  // and marks the account ready for usage observation.
  return { ...emptyEvidence(),
    availability: [evidenceFact(scope, "provider-cli", observedAt, observedAt + lengthS, "usage_observed", "ready")],
    budget: [evidenceFact(scope, "provider-cli", observedAt, null, "quota_observed",
      { name, usedPct, resetsAt: now + lengthS, lengthS, paced: name === "weekly" })] };
}

test("a fresh valid observation retires a previously persisted zero-duration window", () => {
  const merged = reconcileEvidence(zeroDurationWindow(), freshQuota(15), now);
  const names = merged.facts.budget.map(f => f.value.name);
  expect(names).toContain("weekly");
  expect(names).not.toContain("0h");
});

test("a zero-duration window is retained when no fresh observation supersedes it", () => {
  // Do not infer recovery from the mere absence of a new reading.
  const merged = reconcileEvidence(zeroDurationWindow(), emptyEvidence(), now);
  expect(merged.facts.budget.map(f => f.value.name)).toEqual(["0h"]);
});

test("an empty fresh read does not retire a zero-duration window", () => {
  const merged = reconcileEvidence(zeroDurationWindow(), freshQuota(15), now);
  expect(merged.facts.budget.some(f => f.value.name === "0h")).toBe(false);
  // And a read that found nothing leaves it untouched.
  const retained = reconcileEvidence(zeroDurationWindow(), { ...emptyEvidence(), budget: [] }, now);
  expect(retained.facts.budget.some(f => f.value.name === "0h")).toBe(true);
});

test("real expired, unknown and exhausted windows are preserved after retirement", () => {
  const previous = { ...emptyEvidence(), budget: [
    evidenceFact(scope, "session-log", now - 8000, null, "quota_observed",
      { name: "5h", usedPct: 10, resetsAt: now - 1000, lengthS: 18000, paced: false }), // expired, rolled
    evidenceFact(scope, "session-log", now - 60, null, "quota_observed",
      { name: "daily", usedPct: null, resetsAt: null, lengthS: 86400, paced: true }),     // unknown percent
    evidenceFact(scope, "session-log", now - 60, null, "quota_observed",
      { name: "limit", usedPct: 100, resetsAt: now + 3600, lengthS: 21600, paced: false }), // exhausted
  ] };
  const merged = reconcileEvidence(previous, freshQuota(15), now);
  const names = merged.facts.budget.map(f => f.value.name);
  expect(names).toEqual(expect.arrayContaining(["5h", "daily", "limit", "weekly"]));
  expect(names).not.toContain("0h");
});

test("manual configuration limits are preserved after retirement", () => {
  const manual = { ...emptyEvidence(), budget: [
    evidenceFact(scope, "configuration", 0, now + 86400, "config_limit",
      { name: "limit", usedPct: 100, resetsAt: now + 86400, lengthS: 21600, paced: false }),
  ] };
  const merged = reconcileEvidence(manual, freshQuota(15), now);
  expect(merged.facts.budget.some(f => f.value.name === "limit" && f.source === "configuration")).toBe(true);
});

test("retiring the zero-duration window lets fresh quota prove eligibility", () => {
  const previous = zeroDurationWindow();
  const merged = reconcileEvidence(previous, freshQuota(15), now);
  const decision = evaluateEligibility({ now, scope, usage: "quota", allowPaid: false, evidence: merged, restrictions: [] });
  expect(decision.state).toBe("eligible");
  expect(decision.budget).toBe("permitted");
});

test("an unrelated-account fresh observation does not retire another account's invalid fact", () => {
  const other = { account: "two", identity: "two" };
  const previous = zeroDurationWindow(); // account "one"
  const incoming = { ...emptyEvidence(), budget: [evidenceFact(other, "provider-cli", now, null, "quota_observed", {
    name: "weekly", usedPct: 15, resetsAt: now + 604800, lengthS: 604800, paced: true,
  })] };
  const merged = reconcileEvidence(previous, incoming, now);
  expect(merged.facts.budget.some(f => f.value.name === "0h")).toBe(true);
});

test("a runner-restricted fresh observation cannot clear an account-wide zero-duration fact", () => {
  const incoming = { ...emptyEvidence(), budget: [evidenceFact({ ...scope, runner: "r1" }, "provider-cli", now, null, "quota_observed", {
    name: "weekly", usedPct: 15, resetsAt: now + 604800, lengthS: 604800, paced: true,
  })] };
  const merged = reconcileEvidence(zeroDurationWindow(), incoming, now);
  expect(merged.facts.budget.some(f => f.value.name === "0h")).toBe(true);
});

test("zero-length configuration and manual limits are never globally discarded", () => {
  const previous = { ...emptyEvidence(), budget: [evidenceFact(scope, "configuration", 0, now + 86400, "config_limit",
    { name: "limit", usedPct: 100, resetsAt: now + 86400, lengthS: 0, paced: false })] };
  const merged = reconcileEvidence(previous, freshQuota(15), now);
  expect(merged.facts.budget.some(f => f.source === "configuration" && f.value.name === "limit")).toBe(true);
});

test("zero-length execution failures are not discarded without a fresh measured witness", () => {
  const previous = { ...emptyEvidence(), budget: [evidenceFact(scope, "execution", now - 7200, now + 3600, "quota_failure",
    { name: "limit", usedPct: 100, resetsAt: now + 3600, lengthS: 0, paced: false })] };
  const merged = reconcileEvidence(previous, emptyEvidence(), now);
  expect(merged.facts.budget.some(f => f.source === "execution" && f.value.name === "limit")).toBe(true);
});

test("a different identity's invalid fact is preserved under retirement", () => {
  const otherId = { account: "one", identity: "two" };
  const previous = { ...emptyEvidence(), budget: [evidenceFact(otherId, "session-log", now - 86400, null, "quota_observed",
    { name: "0h", usedPct: null, resetsAt: null, lengthS: 0, paced: false })] };
  const merged = reconcileEvidence(previous, freshQuota(15), now);
  expect(merged.facts.budget.some(f => f.value.name === "0h")).toBe(true);
});

test("an expired or unknown-percentage reading does not retire a zero-duration fact", () => {
  const expired = { ...emptyEvidence(), budget: [evidenceFact(scope, "provider-cli", 1, 2, "quota_observed",
    { name: "weekly", usedPct: 15, resetsAt: 2, lengthS: 604800, paced: true })] };
  expect(reconcileEvidence(zeroDurationWindow(), expired, now).facts.budget.some(f => f.value.name === "0h")).toBe(true);
  const unknown = { ...emptyEvidence(), budget: [evidenceFact(scope, "provider-cli", now, null, "quota_observed",
    { name: "weekly", usedPct: null, resetsAt: now + 604800, lengthS: 604800, paced: true })] };
  expect(reconcileEvidence(zeroDurationWindow(), unknown, now).facts.budget.some(f => f.value.name === "0h")).toBe(true);
});

test("an observation older than the invalid fact cannot retire it", () => {
  const previous = { ...emptyEvidence(), budget: [evidenceFact(scope, "session-log", now - 60, null, "quota_observed",
    { name: "0h", usedPct: null, resetsAt: null, lengthS: 0, paced: false })] };
  const incoming = { ...emptyEvidence(), budget: [evidenceFact(scope, "provider-cli", now - 3600, null, "quota_observed",
    { name: "weekly", usedPct: 15, resetsAt: now + 604800, lengthS: 604800, paced: true })] };
  const merged = reconcileEvidence(previous, incoming, now);
  expect(merged.facts.budget.some(f => f.value.name === "0h")).toBe(true);
});

test("a returned historical alternative zero-duration fact is also retired, not reintroduced", () => {
  const fresh = freshQuota(15);
  const incoming = { ...fresh, budget: [...fresh.budget,
    evidenceFact(scope, "session-log", now - 86400, null, "quota_observed",
      { name: "0h", usedPct: null, resetsAt: null, lengthS: 0, paced: false })] };
  const merged = reconcileEvidence(emptyEvidence(), incoming, now);
  const names = merged.facts.budget.map(f => f.value.name);
  expect(names).toContain("weekly");
  expect(names).not.toContain("0h");
});

for (const [label, usedPct, stale] of [
  ["explicitly stale", 15, true],
  ["NaN percentage", NaN, false],
  ["negative percentage", -1, false],
  ["over-100 percentage", 101, false],
] as const) {
  test(`a ${label} witness cannot retire historical quota`, () => {
    const incoming = freshQuota(usedPct);
    incoming.budget[0].value.stale = stale;
    expect(reconcileEvidence(zeroDurationWindow(), incoming, now).facts.budget
      .some(f => f.value.name === "0h")).toBe(true);
  });
}

test("zero-duration measured constraints with another name are preserved", () => {
  const previous = zeroDurationWindow();
  previous.budget[0] = evidenceFact(scope, "session-log", now - 60, null, "quota_observed",
    { name: "limit", usedPct: 100, resetsAt: null, lengthS: 0, paced: false });
  const merged = reconcileEvidence(previous, freshQuota(15), now);
  expect(merged.facts.budget.some(f => f.value.name === "limit")).toBe(true);
});
