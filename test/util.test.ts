import { expect, test } from "bun:test";
import { join } from "node:path";
import { isObj, parseTs, toNum } from "../src/util";
import { readJson, writeJsonAtomic } from "../src/fsutil";
import { tmpDir } from "./helpers";

test("parseTs accepts unix seconds, milliseconds, numeric strings and ISO-8601", () => {
  expect(parseTs(1791046794)).toBe(1791046794);
  expect(parseTs(1791046794000)).toBe(1791046794);
  expect(parseTs("1791046794")).toBe(1791046794);
  expect(parseTs("2026-10-12T00:00:00+08:00")).toBe(Date.parse("2026-10-11T16:00:00Z") / 1000);
  expect(parseTs("")).toBeNull();
  expect(parseTs(null)).toBeNull();
  expect(parseTs("not a date")).toBeNull();
});

test("toNum and isObj", () => {
  expect(toNum(16.9)).toBe(16.9);
  expect(toNum("16")).toBeNull();
  expect(toNum(Number.NaN)).toBeNull();
  expect(isObj({})).toBe(true);
  expect(isObj([])).toBe(false);
  expect(isObj(null)).toBe(false);
});

test("writeJsonAtomic creates parent dirs and readJson round-trips; readJson returns null on garbage", async () => {
  const dir = tmpDir();
  const p = join(dir, "a", "b", "x.json");
  writeJsonAtomic(p, { v: 1 });
  expect(readJson<{ v: number }>(p)).toEqual({ v: 1 });
  await Bun.write(join(dir, "bad.json"), "{nope");
  expect(readJson(join(dir, "bad.json"))).toBeNull();
  expect(readJson(join(dir, "missing.json"))).toBeNull();
});
