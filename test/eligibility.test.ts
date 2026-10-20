import { expect, test } from "bun:test";
import { evaluateEligibility } from "../src/engine/eligibility";
import { emptyEvidence, evidenceFact, reconcileEvidence } from "../src/engine/evidence";
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
