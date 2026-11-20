import { expect, test } from "bun:test";
import { retryBusy } from "../src/tasks/store";

const busy = () => Object.assign(Error("database is locked"), { code: "SQLITE_BUSY" });

test("retryBusy retries SQLITE_BUSY until the statement succeeds", () => {
  let calls = 0;
  const slept: number[] = [];
  const result = retryBusy(() => { if (++calls < 3) throw busy(); return "wal"; }, 5000, ms => slept.push(ms));
  expect(result).toBe("wal");
  expect(calls).toBe(3);
  expect(slept).toEqual([25, 25]);
});

test("retryBusy rethrows other errors at once", () => {
  let calls = 0;
  expect(() => retryBusy(() => { calls++; throw Object.assign(Error("disk I/O error"), { code: "SQLITE_IOERR" }); }, 5000, () => {})).toThrow("disk I/O error");
  expect(calls).toBe(1);
});

test("retryBusy gives up after its deadline", () => {
  let calls = 0;
  expect(() => retryBusy(() => { calls++; throw busy(); }, 0, () => {})).toThrow("database is locked");
  expect(calls).toBe(1);
});
