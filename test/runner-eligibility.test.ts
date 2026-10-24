import { afterEach, expect, test } from "bun:test";
import { prepareLaunch, launchEvidenceCurrent } from "../src/tasks/eligibility";
import { computeStatus } from "../src/engine/status";
import { validateStrategy } from "../src/config/strategy";
import { fakeCtx, cleanupUsageFixtures } from "./usage-plugin-fixtures";
import { blockExecutor } from "../src/executors/blocked";

afterEach(cleanupUsageFixtures);

function fixture() {
  let used = 10, failed = false;
  const ctx = fakeCtx({ run: async () => failed ? { code: 1, stdout: "", stderr: "timeout" } : {
    code: 0, stderr: "", stdout: JSON.stringify({ items: [{ product: "coding-plan", subscribed: true,
      periods: [{ label: "weekly", percent: used, reset_at: new Date((ctx.now + 86400) * 1000).toISOString() }] }] }),
  } });
  const s = validateStrategy({ planner: "claude-code", providers: { byteplus: { via: "opencode", model: "api/code", usage: "quota", quota_source: "arkcli" } } }, "/x");
  return { ctx, s, set: (value: number) => { used = value; ctx.now++; }, fail: () => { failed = true; ctx.now++; } };
}

test("launch preflight bypasses both caches and observes exhaustion since routing", async () => {
  const { ctx, s, set } = fixture();
  expect((await computeStatus(ctx, s, { profile: null })).executors.ranked[0].eligibility?.state).toBe("eligible");
  set(100);
  const prepared = await prepareLaunch(ctx, s, "opencode#byteplus");
  expect(prepared.decision.state).toBe("ineligible");
  expect(prepared.decision.budget).toBe("exhausted");
});

test("a failed preflight refresh preserves an explicitly uncertain fallback", async () => {
  const { ctx, s, fail } = fixture();
  await computeStatus(ctx, s, { profile: null });
  fail();
  expect((await prepareLaunch(ctx, s, "opencode#byteplus")).decision.state).toBe("uncertain");
});

test("reservation checks reject expired evidence, a later account revision or a new user block", async () => {
  const { ctx, s, set } = fixture();
  const prepared = await prepareLaunch(ctx, s, "opencode#byteplus");
  expect(launchEvidenceCurrent(ctx, prepared)).toBe(true);
  expect(launchEvidenceCurrent({ ...ctx, now: ctx.now + 601 }, prepared)).toBe(false);
  set(30);
  await prepareLaunch(ctx, s, "opencode#byteplus");
  expect(launchEvidenceCurrent(ctx, prepared)).toBe(false);
  const updated = await prepareLaunch(ctx, s, "opencode#byteplus");
  blockExecutor(ctx, "opencode#byteplus", undefined, "maintenance");
  expect(launchEvidenceCurrent(ctx, updated)).toBe(false);
});
