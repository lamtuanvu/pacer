import { expect, test } from "bun:test";
import { cachedFetch } from "../src/usage/cache";
import { limitWindow, markExhausted, readMarks } from "../src/usage/reactive";
import { fakeCtx } from "./helpers";

test("cachedFetch serves fresh hits without calling the fetcher", async () => {
  const ctx = fakeCtx({ now: 1000 });
  let calls = 0;
  const f = async () => ({ n: ++calls });
  expect((await cachedFetch(ctx, "k", 600, 3600, f)).value).toEqual({ n: 1 });
  expect((await cachedFetch({ ...ctx, now: 1500 }, "k", 600, 3600, f)).value).toEqual({ n: 1 });
  expect(calls).toBe(1);
  expect((await cachedFetch({ ...ctx, now: 1700 }, "k", 600, 3600, f)).value).toEqual({ n: 2 });
});

test("cachedFetch falls back to a stale value within maxStale, then gives up with the error", async () => {
  const ctx = fakeCtx({ now: 1000 });
  await cachedFetch(ctx, "k", 60, 3600, async () => "good");
  const boom = async (): Promise<string> => { throw new Error("arkcli down"); };
  const stale = await cachedFetch({ ...ctx, now: 2000 }, "k", 60, 3600, boom);
  expect(stale).toEqual({ value: "good", capturedAt: 1000, stale: true, error: "arkcli down" });
  const gone = await cachedFetch({ ...ctx, now: 9000 }, "k", 60, 3600, boom);
  expect(gone).toEqual({ value: null, capturedAt: null, stale: false, error: "arkcli down" });
});

test("exhausted marks produce a limit window until they expire", () => {
  const ctx = fakeCtx({ now: 1000 });
  expect(limitWindow(ctx, "cursor")).toBeNull();
  markExhausted(ctx, "cursor", 4600);
  expect(readMarks(ctx)).toEqual({ cursor: 4600 });
  expect(limitWindow(ctx, "cursor")).toEqual({ name: "limit", usedPct: 100, resetsAt: 4600, lengthS: 3600, paced: false });
  expect(limitWindow({ ...ctx, now: 5000 }, "cursor")).toBeNull();
});
