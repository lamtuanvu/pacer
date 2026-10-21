import { expect, test } from "bun:test";
import { accountEvidenceScope, mergeEvidence, readEvidence, recordExecutionEvidence } from "../src/core/evidence";
import { emptyEvidence, evidenceFact } from "../src/engine/evidence";
import { evaluateEligibility } from "../src/engine/eligibility";
import { validateStrategy } from "../src/config/strategy";
import { fakeCtx } from "./helpers";

function setup() {
  const ctx = fakeCtx(), account = validateStrategy({ planner: "claude-code", providers: { codex: {} } }, "/x").accounts.codex;
  const scope = accountEvidenceScope(account);
  const decision = () => evaluateEligibility({ now: ctx.now, scope, usage: "quota", allowPaid: false,
    evidence: readEvidence(ctx, scope).evidence, restrictions: [] });
  return { ctx, scope, decision };
}
test("authentication recovery requires newer successful evidence, without claiming budget", async () => {
  const { ctx, scope, decision } = setup();
  await recordExecutionEvidence(ctx, scope, { endedAt: ctx.now - 10, exitCode: 1, timedOut: false, classification: "authentication" });
  await recordExecutionEvidence(ctx, scope, { endedAt: ctx.now - 20, exitCode: 0, timedOut: false, classification: "success" });
  expect(decision().state).toBe("ineligible");
  await recordExecutionEvidence(ctx, scope, { endedAt: ctx.now, exitCode: 0, timedOut: false, classification: "success" });
  expect(decision().availability).toBe("ready");
  expect(decision().budget).toBe("unknown");
});
test("task failures and overload do not poison quota; success does not erase quota restriction", async () => {
  const { ctx, scope, decision } = setup();
  for (const classification of ["task", "transient"] as const) await recordExecutionEvidence(ctx, scope, { endedAt: ctx.now, exitCode: 1, timedOut: false, classification });
  expect(readEvidence(ctx, scope).revision).toBe(0);
  await recordExecutionEvidence(ctx, scope, { endedAt: ctx.now - 10, exitCode: 1, timedOut: false, classification: "quota", until: ctx.now + 3600 });
  await recordExecutionEvidence(ctx, scope, { endedAt: ctx.now, exitCode: 0, timedOut: false, classification: "success" });
  expect(decision().budget).toBe("exhausted");
  expect(decision().state).toBe("ineligible");
});
test("a newer complete quota observation clears an obsolete execution limit", async () => {
  const { ctx, scope, decision } = setup();
  await recordExecutionEvidence(ctx, scope, { endedAt: ctx.now - 30, exitCode: 1, timedOut: false, classification: "quota", until: ctx.now + 86400 });
  await mergeEvidence(ctx, scope, { ...emptyEvidence(), availability: [evidenceFact(scope, "session-log", ctx.now, ctx.now + 7200, "usage_observed", "ready")], budget: [evidenceFact(scope, "session-log", ctx.now, null, "quota_observed", { name: "5h", usedPct: 0, resetsAt: ctx.now + 3600, lengthS: 18000, paced: false })] });
  expect(decision().state).toBe("eligible");
});
