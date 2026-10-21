import { expect, test } from "bun:test";
import { mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { lastRateLimits, readCodex } from "../src/usage/codex";
import { fakeCtx, tmpDir } from "./helpers";

const line = (primary: unknown, secondary: unknown = null, at = "2026-10-10T12:01:35.254Z") =>
  JSON.stringify({
    timestamp: at,
    type: "event_msg",
    payload: { type: "token_count", rate_limits: { limit_id: "codex", primary, secondary, plan_type: "pro" } },
  });

async function rollout(home: string, day: string, name: string, lines: string[], mtime: number) {
  const dir = join(home, ".codex", "sessions", "2026", "10", day);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `rollout-${name}.jsonl`);
  await Bun.write(p, lines.join("\n") + "\n");
  utimesSync(p, mtime, mtime);
  return p;
}

test("lastRateLimits finds the newest nested rate_limits and skips corrupt lines", async () => {
  const dir = tmpDir();
  const p = join(dir, "r.jsonl");
  await Bun.write(p, [
    line({ used_percent: 10, window_minutes: 10080, resets_at: 1792060180 }),
    '{"rate_limits": broken json',
    line({ used_percent: 13, window_minutes: 10080, resets_at: 1792060180 }),
    JSON.stringify({ type: "event_msg", payload: { type: "agent_message", text: "hi" } }),
  ].join("\n"));
  expect((await lastRateLimits(p))?.primary).toEqual({ used_percent: 13, window_minutes: 10080, resets_at: 1792060180 });
});

test("readCodex uses the quota event observation time and maps weekly windows", async () => {
  const ctx = fakeCtx({ now: 1791640000 });
  await rollout(ctx.home, "07", "old", [line({ used_percent: 50, window_minutes: 10080, resets_at: 1791000000 }, null, "2026-10-09T12:00:00Z")], 3000);
  await rollout(ctx.home, "10", "new", [line({ used_percent: 100, window_minutes: 10080, resets_at: 1792060180 })], 2000);
  const r = await readCodex(ctx);
  expect(r.capturedAt).toBe(Date.parse("2026-10-10T12:01:35.254Z") / 1000);
  expect(r.source).toBe("session-log");
  expect(r.windows).toEqual([{ name: "weekly", usedPct: 100, resetsAt: 1792060180, lengthS: 604800, paced: true }]);
});

test("falls back to resets_in_seconds and keeps a 5h secondary window unpaced", async () => {
  const ctx = fakeCtx({ now: 1791640000 });
  await rollout(ctx.home, "10", "a", [line(
    { used_percent: 30, window_minutes: 10080, resets_in_seconds: 3600 },
    { used_percent: 5, window_minutes: 300, resets_at: 1791650000 },
  )], 5000);
  expect((await readCodex(ctx)).windows).toEqual([
    { name: "weekly", usedPct: 30, resetsAt: Date.parse("2026-10-10T12:01:35.254Z") / 1000 + 3600, lengthS: 604800, paced: true },
    { name: "5h", usedPct: 5, resetsAt: 1791650000, lengthS: 18000, paced: false },
  ]);
});

test("no logs is an error reading, not an exception", async () => {
  const r = await readCodex(fakeCtx());
  expect(r.windows).toEqual([]);
  expect(r.error).toContain("Codex");
});

test("a future quota event cannot hide an earlier valid event in the same log", async () => {
  const ctx = fakeCtx({ now: 1791640000 });
  await rollout(ctx.home, "10", "future", [
    line({ used_percent: 20, window_minutes: 300 }, null, "2026-10-10T12:00:00Z"),
    line({ used_percent: 100, window_minutes: 300 }, null, "2027-10-10T12:00:00Z"),
  ], ctx.now);
  expect((await readCodex(ctx)).windows[0]?.usedPct).toBe(20);
});

test("equal-time quota conflicts within a log survive as alternative observations", async () => {
  const ctx = fakeCtx({ now: 1791640000 });
  await rollout(ctx.home, "10", "conflict", [
    line({ used_percent: 20, window_minutes: 300 }),
    line({ used_percent: 40, window_minutes: 300 }),
  ], ctx.now);
  const reading = await readCodex(ctx);
  expect([reading.windows[0]?.usedPct, ...reading.alternatives!.map(r => r.windows[0]?.usedPct)].sort()).toEqual([20, 40]);
});

test("out-of-order events and unrelated file writes do not renew quota evidence", async () => {
  const ctx = fakeCtx({ now: 1791640000 });
  await rollout(ctx.home, "10", "order", [
    line({ used_percent: 0, window_minutes: 300 }, null, "2026-10-10T12:00:00Z"),
    line({ used_percent: 100, window_minutes: 300 }, null, "2026-10-09T12:00:00Z"),
    JSON.stringify({ timestamp: "2026-10-10T13:00:00Z", message: "unrelated" }),
  ], ctx.now);
  const r = await readCodex(ctx);
  expect(r.windows[0].usedPct).toBe(0);
  expect(r.capturedAt).toBe(1791633600);
});
test("missing event time leaves a relative reset unknown and preserves credit semantics", async () => {
  const ctx = fakeCtx();
  await rollout(ctx.home, "10", "unknown", [JSON.stringify({ rate_limits: {
    primary: { used_percent: 100, window_minutes: 300, resets_in_seconds: 60 },
    credits: { has_credits: true, balance: "20" },
  } })], ctx.now);
  const r = await readCodex(ctx);
  expect(r.capturedAt).toBeNull();
  expect(r.windows[0].resetsAt).toBeNull();
  expect(r.spending).toEqual({ creditsAvailable: true, creditBalance: 20, paidConsumption: "unknown" });
});
