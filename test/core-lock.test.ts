import { expect, test } from "bun:test";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withLock, withLockSync } from "../src/core/lock";
import { fakeCtx } from "./helpers";

test("withLock serialises holders of the same name", async () => {
  const ctx = fakeCtx();
  const order: string[] = [];
  const a = withLock(ctx, "x", async () => { order.push("a1"); await Bun.sleep(60); order.push("a2"); });
  const b = withLock(ctx, "x", async () => { order.push("b1"); });
  await Promise.all([a, b]);
  expect(order).toEqual(["a1", "a2", "b1"]);
});

test("withLock keeps lock files where older pacer versions look for them", async () => {
  const ctx = fakeCtx();
  await withLock(ctx, "y", async () => {
    expect(existsSync(join(ctx.pacerHome, "orca", "y.lock"))).toBe(true);
  });
  expect(existsSync(join(ctx.pacerHome, "orca", "y.lock"))).toBe(false);
});

test("withLock takes over a stale lock", async () => {
  const ctx = fakeCtx();
  mkdirSync(join(ctx.pacerHome, "orca"), { recursive: true });
  const f = join(ctx.pacerHome, "orca", "z.lock");
  writeFileSync(f, "");
  const old = (Date.now() - 10 * 60_000) / 1000;
  utimesSync(f, old, old);
  expect(await withLock(ctx, "z", async () => "ran", { timeoutMs: 1000 })).toBe("ran");
});


test("synchronous lock callbacks release before another synchronous caller waits", async () => {
  const ctx = fakeCtx();
  const pending = withLock(ctx, "startup", () => "merged");
  try {
    expect(withLockSync(ctx, "startup", () => "started", { timeoutMs: 100 })).toBe("started");
  } finally {
    await pending;
  }
});

test("a synchronous waiter refuses instead of spinning while an async holder awaits", async () => {
  const ctx = fakeCtx();
  let resumed = false;
  const holder = withLock(ctx, "session-create", async () => {
    await Bun.sleep(150);
    resumed = true;
    return "held";
  });
  await Bun.sleep(30); // the holder owns the file and is suspended at its await
  const started = Date.now();
  let refused: Error | null = null;
  try {
    withLockSync(ctx, "session-create", () => "started", { timeoutMs: 1000 });
  } catch (e) {
    refused = e as Error;
  }
  // It refused at once instead of spinning to its deadline on a blocked event loop,
  // which would stop the suspended holder from ever resuming to release.
  expect(refused?.message).toMatch(/synchronously/);
  expect(Date.now() - started).toBeLessThan(1000);
  expect(resumed).toBe(false);
  await holder;
  expect(resumed).toBe(true);
});

test("a synchronous conflict waiter stays non-blocking while an async holder awaits", async () => {
  const ctx = fakeCtx();
  const holder = withLock(ctx, "session-create", async () => {
    await Bun.sleep(100);
    return "held";
  });
  await Bun.sleep(20);
  // commitDelegate waits for session-create with these exact options.
  expect(() =>
    withLockSync(ctx, "session-create", () => "committed", { timeoutMs: 0, staleMs: 600000, conflict: true }),
  ).toThrow("Workspace admission is busy; refresh and retry");
  await holder;
});
