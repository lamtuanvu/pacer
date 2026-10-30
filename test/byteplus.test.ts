import { afterEach as afterUsageFixture } from "bun:test";
import { fakeCtx, cleanupUsageFixtures } from "./usage-plugin-fixtures";
afterUsageFixture(cleanupUsageFixtures);
import { expect, test } from "bun:test";
import { monthBefore, readByteplus } from "../src/usage/byteplus";
import type { RunFn } from "../src/types";


const ARK = JSON.stringify({
  items: [{
    product: "coding-plan", edition: "personal", subscribed: true,
    periods: [
      { label: "session", percent: 0 },
      { label: "weekly", percent: 16.91377725, reset_at: "2026-10-12T00:00:00+08:00" },
      { label: "monthly", percent: 8.456888625, reset_at: "2026-11-09T23:59:59+08:00" },
    ],
    updated_at: 1791633647,
  }],
});

test("monthBefore handles month-length overflow", () => {
  const ts = (s: string) => Date.parse(s) / 1000;
  expect(monthBefore(ts("2026-11-09T15:59:59Z"))).toBe(ts("2026-10-09T15:59:59Z"));
  expect(monthBefore(ts("2026-03-31T00:00:00Z"))).toBe(ts("2026-02-28T00:00:00Z"));
});

test("maps session, weekly and monthly periods and caches for 10 minutes", async () => {
  const calls: string[][] = [];
  const run: RunFn = async (argv) => { calls.push(argv); return { code: 0, stdout: ARK, stderr: "" }; };
  const ctx = fakeCtx({ now: 1791640000, run });
  const r = await readByteplus(ctx);
  expect(calls[0]).toEqual(["arkcli", "usage", "plan", "--product", "coding-plan"]);
  const weeklyReset = Date.parse("2026-10-12T00:00:00+08:00") / 1000;
  const monthlyReset = Date.parse("2026-11-09T23:59:59+08:00") / 1000;
  expect(r.windows).toEqual([
    { name: "5h", usedPct: 0, resetsAt: null, lengthS: 18000, paced: false },
    { name: "weekly", usedPct: 16.91377725, resetsAt: weeklyReset, lengthS: 604800, paced: true },
    { name: "monthly", usedPct: 8.456888625, resetsAt: monthlyReset, lengthS: monthlyReset - monthBefore(monthlyReset), paced: true },
  ]);
  await readByteplus({ ...ctx, now: 1791640000 + 300 });
  expect(calls.length).toBe(1);
});

test("arkcli failure with no cache is an error reading; no subscription is reported", async () => {
  const fail = fakeCtx({ run: async () => ({ code: 1, stdout: "", stderr: "auth expired" }) });
  const r = await readByteplus(fail);
  expect(r.windows).toEqual([]);
  expect(r.error).toContain("auth expired");
  const none = fakeCtx({ run: async () => ({ code: 0, stdout: JSON.stringify({ items: [] }), stderr: "" }) });
  expect((await readByteplus(none)).error).toBe("no active coding-plan subscription");
});

test("confirmed missing subscription is unavailable but malformed and transient responses are uncertain", async () => {
  for (const [payload, state] of [[{ items: [{ product: "coding-plan", subscribed: false }] }, "unavailable"], [{}, "unknown"]] as const) {
    const ctx = fakeCtx({ run: async () => ({ code: 0, stdout: JSON.stringify(payload), stderr: "" }) });
    expect((await readByteplus(ctx)).availability?.state).toBe(state);
  }
});
test("Ark CLI authentication failure inside a successful usage response is not a missing subscription", async () => {
  const ctx = fakeCtx({ run: async () => ({ code: 0, stdout: JSON.stringify({ items: [{
    product: "coding-plan", subscribed: false,
    error: "GetCodingPlanUsage requires BytePlus Ark SSO STS, please run `arkcli auth login`: refresh_token is invalid",
  }] }), stderr: "" }) });
  const reading = await readByteplus(ctx);
  expect(reading.availability).toMatchObject({ state: "unknown", reason: "authentication_failed" });
  expect(reading.error).toBe("Ark CLI sign-in required. Run arkcli auth login.");
});
test("explicit refresh bypasses the provider response cache without renewing a failed observation", async () => {
  let subscribed = true;
  const ctx = fakeCtx({ run: async () => ({ code: 0, stdout: subscribed ? ARK : JSON.stringify({ items: [{ product: "coding-plan", subscribed: false }] }), stderr: "" }) });
  await readByteplus(ctx);
  subscribed = false;
  expect((await readByteplus({ ...ctx, now: ctx.now + 1 }, true)).availability?.state).toBe("unavailable");
});
