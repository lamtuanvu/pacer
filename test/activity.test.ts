import { expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildActivity, hourBin, loadActivity } from "../src/pace/activity";
import { fakeCtx, localTs } from "./helpers";

async function claudeLog(home: string, name: string, stamps: number[]) {
  const dir = join(home, ".claude", "projects", "-proj");
  mkdirSync(dir, { recursive: true });
  const lines = stamps.map((s) => JSON.stringify({ type: "user", timestamp: new Date(s * 1000).toISOString() }));
  await Bun.write(join(dir, `${name}.jsonl`), lines.join("\n"));
}

test("hourBin is local weekday*24+hour", () => {
  expect(hourBin(localTs(2026, 10, 5, 9, 30))).toBe(1 * 24 + 9); // Monday 09:30
  expect(hourBin(localTs(2026, 10, 11, 23, 0))).toBe(0 * 24 + 23); // Sunday 23:00
});

test("learns active hours from 8 days of logs; each clock hour counts once", async () => {
  const ctx = fakeCtx({ now: localTs(2026, 10, 13, 20, 0) });
  const stamps: number[] = [];
  for (let d = 5; d <= 12; d++) {
    for (const h of [9, 10, 11]) stamps.push(localTs(2026, 10, d, h, 5), localTs(2026, 10, d, h, 40));
  }
  stamps.push(localTs(2026, 10, 7, 3, 0)); // one stray night hour
  await claudeLog(ctx.home, "a", stamps);
  const p = await buildActivity(ctx);
  expect(p.days).toBe(8);
  expect(p.bins.length).toBe(168);
  expect(p.bins[1 * 24 + 9]).toBe(2); // two Mondays (Oct 5 and Oct 12) at 09:00
  expect(p.active[1 * 24 + 9]).toBe(true);
  expect(p.active[3 * 24 + 3]).toBe(true); // Wednesday 03:00: 1 of max 2 is >= 20%
  expect(p.active[1 * 24 + 15]).toBe(false);
});

test("no logs yields an empty profile; loadActivity caches for 24h", async () => {
  const ctx = fakeCtx({ now: 1_000_000 });
  const p = await loadActivity(ctx);
  expect(p.days).toBe(0);
  expect(p.active.some(Boolean)).toBe(false);
  expect(existsSync(join(ctx.pacerHome, "activity.json"))).toBe(true);
  await claudeLog(ctx.home, "late", [1_000_000 - 3600]);
  expect((await loadActivity({ ...ctx, now: 1_000_000 + 3600 })).days).toBe(0); // cached
  expect((await loadActivity({ ...ctx, now: 1_000_000 + 90_000 })).days).toBe(1); // rebuilt
});
