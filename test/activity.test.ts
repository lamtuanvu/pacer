import { expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as childProcess from "node:child_process";
import { once } from "node:events";
import { buildActivity, hourBin, loadActivity } from "../src/pace/activity";
import * as activity from "../src/pace/activity";
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
  const stale = { ...ctx, now: 1_000_000 + 90_000 };
  let triggers = 0;
  expect((await loadActivity(stale, { trigger: () => { triggers++; } })).days).toBe(0);
  expect(triggers).toBe(1);
  expect((await activity.rebuildActivity(stale)).days).toBe(1);
  expect((await loadActivity(stale)).days).toBe(1);
});

test("five parallel stale loads return the cache and trigger one rebuild", async () => {
  const ctx = fakeCtx({ now: 1_000_000 });
  await loadActivity(ctx);
  await claudeLog(ctx.home, "late", [ctx.now - 3600]);
  const stale = { ...ctx, now: ctx.now + 90_000 };
  let triggers = 0;
  const profiles = await Promise.all(Array.from({ length: 5 }, () =>
    loadActivity(stale, { trigger: () => { triggers++; } }),
  ));
  expect(profiles.map((p) => p.days)).toEqual([0, 0, 0, 0, 0]);
  expect(triggers).toBe(1);
});

test("stale activity locks are replaced, recent locks are held, and rebuild releases the lock", async () => {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  const path = join(ctx.pacerHome, "activity.lock");
  writeFileSync(path, JSON.stringify({ at: ctx.now - 601, pid: 1 }));
  expect(activity.tryActivityLock(ctx)).toBe(true);
  writeFileSync(path, JSON.stringify({ at: ctx.now - 10, pid: 1 }));
  expect(activity.tryActivityLock(ctx)).toBe(false);
  await activity.rebuildActivity(ctx);
  expect(existsSync(path)).toBe(true);
});

test("unreadable logs are skipped while readable logs still count", async () => {
  const ctx = fakeCtx();
  const readableTs = ctx.now - 3600;
  await claudeLog(ctx.home, "readable", [readableTs]);
  await claudeLog(ctx.home, "unreadable", [ctx.now - 86400]);
  const path = join(ctx.home, ".claude", "projects", "-proj", "unreadable.jsonl");
  const mode = statSync(path).mode;
  try {
    chmodSync(path, 0o000);
    const p = await buildActivity(ctx);
    expect(p.days).toBe(1);
    expect(p.bins[hourBin(readableTs)]).toBe(1);
    expect(p.bins.reduce((sum, count) => sum + count, 0)).toBe(1);
  } finally {
    chmodSync(path, mode);
  }
});

test("release keeps another process lock and removes only its own", () => {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  const path = join(ctx.pacerHome, "activity.lock");
  writeFileSync(path, JSON.stringify({ at: ctx.now, pid: process.pid + 1 }));
  activity.releaseActivityLock(ctx);
  expect(existsSync(path)).toBe(true);
  writeFileSync(path, JSON.stringify({ at: ctx.now, pid: process.pid }));
  activity.releaseActivityLock(ctx);
  expect(existsSync(path)).toBe(false);
});

test("stale takeover reports failure if another process replaced its newly written lock", async () => {
  const { spyOn } = await import("bun:test");
  const fs = await import("node:fs");
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  const path = join(ctx.pacerHome, "activity.lock");
  writeFileSync(path, JSON.stringify({ at: ctx.now - 601, pid: 1 }));
  const realWrite = fs.writeFileSync;
  const spy = spyOn(fs, "writeFileSync").mockImplementation((...args: Parameters<typeof realWrite>) => {
    realWrite(...args);
    if (args[0] === path) realWrite(path, JSON.stringify({ at: ctx.now, pid: process.pid + 1 }));
  });
  try { expect(activity.tryActivityLock(ctx)).toBe(false); }
  finally { spy.mockRestore(); }
});

test("detached activity child releases the parent's lock immediately after rebuilding", async () => {
  const ctx = fakeCtx();
  const argv = process.argv[1];
  const lock = join(ctx.pacerHome, "activity.lock");
  // Observe the real detached child. Completion, rather than a three-second
  // startup budget, is the boundary at which the lock must already be gone.
  const realSpawn = childProcess.spawn;
  let completion: Promise<unknown[]> | undefined;
  const spawn = spyOn(childProcess, "spawn").mockImplementation(((...args: Parameters<typeof realSpawn>) => {
    const child = realSpawn(...args);
    completion = once(child, "exit");
    return child;
  }) as typeof realSpawn);
  try {
    process.argv[1] = new URL("../src/cli.ts", import.meta.url).pathname;
    expect(activity.tryActivityLock(ctx)).toBe(true);
    activity.backgroundRebuild(ctx);
  } finally {
    process.argv[1] = argv;
    spawn.mockRestore();
  }
  expect(completion).toBeDefined();
  expect(await completion!).toEqual([0, null]);
  expect(existsSync(join(ctx.pacerHome, "activity.json"))).toBe(true);
  expect(existsSync(lock)).toBe(false);
});

test("activity child token cannot release a replacement lock", () => {
  const ctx = fakeCtx({ env: { PACER_ACTIVITY_LOCK_TOKEN: "old-token" } });
  mkdirSync(ctx.pacerHome, { recursive: true });
  const lock = join(ctx.pacerHome, "activity.lock");
  writeFileSync(lock, JSON.stringify({ at: ctx.now, pid: process.pid, token: "new-token" }));
  activity.releaseActivityLock(ctx);
  expect(existsSync(lock)).toBe(true);
  ctx.env.PACER_ACTIVITY_LOCK_TOKEN = "new-token";
  activity.releaseActivityLock(ctx);
  expect(existsSync(lock)).toBe(false);
});
