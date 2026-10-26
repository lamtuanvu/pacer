import { expect, test } from "bun:test";
import { existsSync, mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withLock } from "../src/core/lock";
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
    if (process.platform !== "win32") {
      expect(statSync(join(ctx.pacerHome, "orca")).mode & 0o777).toBe(0o700);
      expect(statSync(join(ctx.pacerHome, "orca", "y.lock")).mode & 0o777).toBe(0o600);
    }
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
