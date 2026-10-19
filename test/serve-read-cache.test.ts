import { expect, test } from "bun:test";
import { createReadCache } from "../src/serve/read-cache";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test("cold readers share one build; warm readers return stale during refresh", async () => {
  let calls = 0;
  const first = deferred<number>(), next = deferred<number>();
  const cache = createReadCache(() => (++calls === 1 ? first.promise : next.promise), 0);
  const a = cache.get(), b = cache.get();
  await Bun.sleep(10);
  expect(calls).toBe(1);
  first.resolve(1);
  expect(await Promise.all([a, b])).toEqual([1, 1]);
  expect(await cache.get()).toBe(1);
  await Bun.sleep(10);
  expect(calls).toBe(2);
  expect(await cache.get()).toBe(1);
  expect(calls).toBe(2);
  next.resolve(2);
  await Bun.sleep(10);
  expect(await cache.get()).toBe(2);
  cache.stop();
});

test("a failed refresh preserves the last value and can retry", async () => {
  let calls = 0;
  const cache = createReadCache(async () => {
    calls++;
    if (calls === 2) throw Error("temporary failure");
    return calls;
  }, 0);
  expect(await cache.get()).toBe(1);
  expect(await cache.get()).toBe(1);
  await Bun.sleep(10);
  expect(await cache.get()).toBe(1);
  await Bun.sleep(10);
  expect(await cache.get()).toBe(3);
  cache.stop();
});
