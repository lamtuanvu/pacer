import { expect, test } from "bun:test";
import { statSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
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

test("corrupt persisted fact values are discarded instead of becoming eligibility evidence", async () => {
  const ctx = fakeCtx(), scope = accountEvidenceScope(account());
  const saved = await mergeEvidence(ctx, scope, { ...emptyEvidence(), budget: [
    evidenceFact(scope, "session-log", ctx.now, null, "quota", { name: "5h", usedPct: 10, resetsAt: null, lengthS: 18000, paced: false }),
  ] });
  (saved.evidence.facts.budget[0] as { value: unknown }).value = null;
  writeFileSync(join(ctx.pacerHome, "state/evidence", `${scope.identity}.json`), JSON.stringify(saved));
  expect(readEvidence(ctx, scope).revision).toBe(0);
});

test("removing and recreating the same account retires old observations and in-flight writes", async () => {
  const { remove } = await import("../src/core/accounts");
  const { loadStrategy } = await import("../src/config/strategy");
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, {recursive:true});
  const strategy = "accounts:\n  planner: {kind: claude}\n  spare: {kind: endpoint, usage: unmetered}\nplanner: claude-code#planner\nrouting: []\n";
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), strategy);
  const scope = accountEvidenceScope(loadStrategy(ctx).accounts.spare);
  const old = { ...emptyEvidence(), availability: [evidenceFact(scope, "execution", ctx.now - 1, ctx.now + 600, "authentication_failed", "unavailable" as const)] };
  const first = await mergeEvidence(ctx, scope, old);
  await remove(ctx, "spare");
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), strategy);
  const recreated = await mergeEvidence(ctx, scope, old);
  expect(recreated.revision).toBeGreaterThan(first.revision);
  expect(recreated.evidence.facts.availability).toEqual([]);
  const next = await mergeEvidence({...ctx, now:ctx.now+1}, scope, { ...emptyEvidence(), availability: [evidenceFact(scope,"configuration",0,null,"measurement_contract","ready")] });
  expect(next.evidence.facts.availability[0].value).toBe("ready");
});
