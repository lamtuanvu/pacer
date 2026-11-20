import { expect, test } from "bun:test";
import { evaluateEligibility } from "../src/engine/eligibility";
import { emptyEvidence, evidenceFact, readingEvidence, reconcileEvidence } from "../src/engine/evidence";
import type { AccountEvidence, EvidenceScope } from "../src/evidence/types";

const now = 1_000_000;
const scope: EvidenceScope = { account: "one", identity: "one" };
function facts(usedPct = 25, observedAt = now - 60): AccountEvidence {
  return {
    availability: [evidenceFact(scope, "provider-cli", observedAt, now + 600, "subscription", "ready")],
    budget: [evidenceFact(scope, "session-log", observedAt, null, "quota", { name: "5h", usedPct, resetsAt: now + 3600, lengthS: 18000, paced: false })],
    spending: [],
  };
}
function decide(evidence = facts(), extra: Record<string, unknown> = {}) {
  return evaluateEligibility({ now, scope, usage: "quota", allowPaid: false,
    evidence: reconcileEvidence(emptyEvidence(), evidence, now), restrictions: [], ...extra });
}

test("valid exhaustion excludes even with credits; permission to pay remains separate", () => {
  const evidence = facts(100);
  evidence.spending.push(evidenceFact(scope, "session-log", now - 60, now + 600, "credits", {
    creditsAvailable: true, creditBalance: 20, paidConsumption: "unknown",
  }));
  expect(decide(evidence).state).toBe("ineligible");
  expect(decide(evidence).budget).toBe("exhausted");
  expect(decide(evidence).spendingRisk).toBe("unknown");
  expect(decide(evidence, { allowPaid: true }).state).toBe("eligible");
});

test("age and reset boundaries invalidate exhausted evidence without inventing quota", () => {
  expect(decide(facts(100, now - 7200)).state).toBe("uncertain");
  const evidence = facts(100);
  evidence.budget[0].value.resetsAt = now;
  expect(decide(evidence).state).toBe("uncertain");
  expect(evidence.budget[0].value.usedPct).toBe(100);
});

test("a valid weekly window does not conceal an expired short window", () => {
  const evidence = facts(10, now - 8000);
  evidence.availability = facts().availability;
  evidence.budget.push(evidenceFact(scope, "session-log", now - 8000, null, "quota", {
    name: "weekly", usedPct: 10, resetsAt: now + 86400, lengthS: 604800, paced: true,
  }));
  expect(decide(evidence).state).toBe("uncertain");
});

test("missing or future observation timestamps never establish current budget", () => {
  const evidence = facts();
  evidence.budget[0].observedAt = null;
  expect(decide(evidence).state).toBe("uncertain");
  evidence.budget[0].observedAt = now + 1;
  expect(decide(evidence).state).toBe("uncertain");
});

test("explicit unavailability and restrictions outrank uncertainty", () => {
  const evidence = emptyEvidence();
  evidence.availability = [evidenceFact(scope, "provider-cli", now, now + 600, "subscription_missing", "unavailable")];
  expect(decide(evidence).state).toBe("ineligible");
  expect(decide(emptyEvidence(), { restrictions: [{ code: "disabled", evidenceIds: [] }] }).state).toBe("ineligible");
});

test("reactive and unmetered contracts do not require synthetic quota windows", () => {
  for (const usage of ["reactive", "unmetered"]) {
    const evidence = { ...emptyEvidence(), availability: facts().availability };
    expect(decide(evidence, { usage }).state).toBe("eligible");
  }
});

test("model-specific evidence cannot authorize or restrict another model", () => {
  const evidence = facts(100);
  evidence.budget[0].scope = { ...scope, model: "other" };
  expect(decide(evidence, { scope: { ...scope, model: "selected" } }).state).toBe("uncertain");
});

test("newer lower usage supersedes a predicted later reset", () => {
  const previous = facts(100, now - 600);
  const incoming = facts(0, now - 60);
  incoming.budget[0].value.resetsAt = now + 700000;
  const merged = reconcileEvidence(previous, incoming, now);
  expect(merged.facts.budget).toHaveLength(1);
  expect(merged.facts.budget[0].value.usedPct).toBe(0);
  expect(evaluateEligibility({ now, scope, usage: "quota", allowPaid: false, evidence: merged, restrictions: [] }).state).toBe("eligible");
});

test("equal-authority contradictions stay uncertain; provider current response wins an equal-time log", () => {
  const previous = facts(10);
  const incoming = facts(40);
  let merged = reconcileEvidence(previous, incoming, now);
  expect(merged.conflicts.length).toBeGreaterThan(0);
  expect(evaluateEligibility({ now, scope, usage: "quota", allowPaid: false, evidence: merged, restrictions: [] }).state).toBe("uncertain");
  incoming.budget[0].source = "provider-cli";
  merged = reconcileEvidence(previous, incoming, now);
  expect(merged.conflicts).toEqual([]);
  expect(merged.facts.budget[0].value.usedPct).toBe(40);
});

test("older or future incoming events cannot replace a known newer observation", () => {
  for (const at of [now - 600, now + 1]) {
    expect(reconcileEvidence(facts(5), facts(100, at), now).facts.budget[0].value.usedPct).toBe(5);
  }
});

test("measurement contracts have no invented observation age", () => {
  const evidence = readingEvidence(scope, { windows: [], capturedAt: null, stale: false, source: "reactive" }, "reactive");
  expect(decide(evidence, { usage: "reactive" }).evidenceAgeS).toBeNull();
});

test("evidence age is the binding budget fact's; an old execution_success fact never pins it", () => {
  const freshBudget = decide(facts(20, now - 60)).evidenceAgeS;
  expect(freshBudget).toBe(60);
  const evidence = facts(20, now - 60);
  evidence.availability.push(evidenceFact(scope, "execution", now - 207 * 3600, now - 205 * 3600, "execution_success", "ready"));
  // The old unrelated availability fact no longer makes the reading look 206 h old.
  expect(decide(evidence).evidenceAgeS).toBe(60);
  // Without any budget fact, the newest availability fact carries the age instead.
  const noBudget: AccountEvidence = { ...emptyEvidence(), availability: [evidenceFact(scope, "provider-cli", now - 7200, now + 600, "usage_observed", "ready")] };
  expect(decide(noBudget).evidenceAgeS).toBe(7200);
});

test("an adapter-declared incomplete window cannot establish available budget", () => {
  const evidence = readingEvidence(scope, { capturedAt: now, stale: false, windows: [{
    name: "5h", usedPct: 10, resetsAt: now + 3600, lengthS: 18000, paced: false, stale: true,
  }] }, "quota");
  expect(decide(evidence).state).toBe("uncertain");
});

test("expired equal-authority execution limit marks stop blocking reactive executors", () => {
  const runnerScope = { ...scope, runner: "cursor", model: "auto", host: "local" };
  const observedAt = now - 14 * 86400;
  const untilA = observedAt + 6 * 3600;
  const untilB = untilA + 0.049;
  const previous: AccountEvidence = {
    availability: [evidenceFact(scope, "configuration", 0, null, "measurement_contract", "ready")],
    budget: [
      evidenceFact(runnerScope, "execution", observedAt, untilA, "quota_failure", {
        name: "limit", usedPct: 100, resetsAt: untilA, lengthS: 21600, paced: false,
      }),
      evidenceFact(runnerScope, "execution", observedAt, untilB, "quota_failure", {
        name: "limit", usedPct: 100, resetsAt: untilB, lengthS: 21600, paced: false,
      }),
    ],
    spending: [],
  };
  // A reactive usage refresh reports no synthetic limit window; reconciliation must still heal.
  const incoming = readingEvidence(scope, {
    windows: [],
    capturedAt: now, stale: false, source: "reactive",
  }, "reactive");
  const merged = reconcileEvidence(previous, incoming, now);
  expect(merged.facts.budget).toEqual([]);
  expect(merged.conflicts).toEqual([]);
  const decision = evaluateEligibility({
    now, scope: runnerScope, usage: "reactive", allowPaid: false, evidence: merged, restrictions: [],
  });
  expect(decision.state).toBe("eligible");
  expect(decision.reasons.map(r => r.code)).not.toContain("evidence_conflicting");
});

test("a still-active execution limit mark continues to exhaust until its cooldown ends", () => {
  const runnerScope = { ...scope, runner: "cursor", model: "auto", host: "local" };
  // Past the two-hour short-window freshness cap, but still inside a six-hour cooldown.
  // Reactive accounts have no measured quota witness, so the mark must keep binding.
  const observedAt = now - 3 * 3600;
  const until = observedAt + 6 * 3600;
  const evidence: AccountEvidence = {
    availability: [evidenceFact(scope, "configuration", 0, null, "measurement_contract", "ready")],
    budget: [evidenceFact(runnerScope, "execution", observedAt, until, "quota_failure", {
      name: "limit", usedPct: 100, resetsAt: until, lengthS: 21600, paced: false,
    })],
    spending: [],
  };
  const merged = reconcileEvidence(emptyEvidence(), evidence, now);
  expect(merged.facts.budget).toHaveLength(1);
  const decision = evaluateEligibility({
    now, scope: runnerScope, usage: "reactive", allowPaid: false, evidence: merged, restrictions: [],
  });
  expect(decision.state).toBe("ineligible");
  expect(decision.reasons.map(r => r.code)).toContain("budget_exhausted");
});

test("evidenceAgeS follows the binding limit, not an older expired fact", () => {
  const runnerScope = { ...scope, runner: "cursor", model: "auto", host: "local" };
  // 150h old expired availability fact (expired 148h ago)
  const oldAvailability = evidenceFact(scope, "session-log", now - 150 * 3600, now - 148 * 3600, "usage_observed", "ready" as const);
  // 68h old execution limit mark still valid for 3h
  const recentLimit = evidenceFact(runnerScope, "execution", now - 68 * 3600, now + 3 * 3600, "quota_failure", {
    name: "limit", usedPct: 100, resetsAt: now + 3 * 3600, lengthS: 21600, paced: false,
  });
  const evidence: AccountEvidence = {
    availability: [oldAvailability, evidenceFact(scope, "configuration", 0, null, "measurement_contract", "ready" as const)],
    budget: [recentLimit],
    spending: [],
  };
  const merged = reconcileEvidence(emptyEvidence(), evidence, now);
  const decision = evaluateEligibility({
    now, scope: runnerScope, usage: "reactive", allowPaid: false, evidence: merged, restrictions: [],
  });
  expect(decision.state).toBe("ineligible");
  expect(decision.reasons.map(r => r.code)).toContain("budget_exhausted");
  // evidenceAgeS should be ~68h (244800s), not ~150h
  expect(decision.evidenceAgeS).not.toBeNull();
  expect(decision.evidenceAgeS!).toBeGreaterThanOrEqual(68 * 3600 - 10);
  expect(decision.evidenceAgeS!).toBeLessThan(69 * 3600);
});
