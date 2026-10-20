import { expect, test } from "bun:test";
import { statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { accountEvidenceScope, mergeEvidence, readEvidence } from "../src/core/evidence";
import { emptyEvidence, evidenceFact } from "../src/engine/evidence";
import { fakeCtx } from "./helpers";
import { validateStrategy } from "../src/config/strategy";
const account = () => validateStrategy({ planner: "claude-code", providers: { codex: {} } }, "/x").accounts.codex;

test("concurrent older writes and restart reads cannot regress account evidence", async () => {
  const ctx = fakeCtx(), scope = accountEvidenceScope(account());
  const incoming = (at: number, usedPct: number) => ({ ...emptyEvidence(), budget: [evidenceFact(scope, "session-log", at, null, "quota", {
    name: "weekly", usedPct, resetsAt: ctx.now + 604800, lengthS: 604800, paced: true,
  })] });
  await Promise.all([mergeEvidence(ctx, scope, incoming(ctx.now - 10, 0)), mergeEvidence(ctx, scope, incoming(ctx.now - 100, 100))]);
  const saved = readEvidence(ctx, scope);
  expect(saved.evidence.facts.budget[0].value.usedPct).toBe(0);
  const same = await mergeEvidence(ctx, scope, incoming(ctx.now - 10, 0));
  expect(same.revision).toBe(saved.revision);
  const dir = join(ctx.pacerHome, "state/evidence");
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir, readdirSync(dir)[0])).mode & 0o777).toBe(0o600);
});

test("account source identity isolates replacement homes, but policy changes share facts", async () => {
  const ctx = fakeCtx(), a = account(), scope = accountEvidenceScope(a);
  await mergeEvidence(ctx, scope, { ...emptyEvidence(), availability: [evidenceFact(scope, "execution", ctx.now, ctx.now + 600, "authentication_failed", "unavailable")] });
  expect(readEvidence(ctx, accountEvidenceScope({ ...a, home: "/different" })).revision).toBe(0);
  expect(accountEvidenceScope({ ...a, allowPaid: true }).identity).toBe(scope.identity);
});

test("readonly reconciliation does not persist new observations", async () => {
  const ctx = { ...fakeCtx(), readOnly: true }, scope = accountEvidenceScope(account());
  const result = await mergeEvidence(ctx, scope, { ...emptyEvidence(), availability: [evidenceFact(scope, "execution", ctx.now, ctx.now + 600, "execution_success", "ready")] });
  expect(result.evidence.facts.availability).toHaveLength(1);
  expect(readEvidence(ctx, scope).revision).toBe(0);
});
