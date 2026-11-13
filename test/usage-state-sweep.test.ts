import { expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { sweepUsageState } from "../src/plugins/usage-state";
import { sweepAtomicWriteTmps } from "../src/fsutil";

const aged = (path: string) => { const at = (Date.now() - 2 * 3600 * 1000) / 1000; utimesSync(path, at, at); return path; };

test("sweepUsageState removes hour-old staging directories in cache and state and keeps fresh ones", async () => {
  const { pacerHome } = fakeCtx();
  const old = ["cache", "state"].map(parent => { const dir = join(pacerHome, parent, ".pacer-usage-state-old"); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "snapshot"), "{}"); return aged(dir); });
  const fresh = join(pacerHome, "cache", ".pacer-usage-state-fresh"); mkdirSync(fresh);
  const unrelated = join(pacerHome, "cache", "keep-dir"); mkdirSync(unrelated); aged(unrelated);
  expect(await sweepUsageState(pacerHome)).toBe(2);
  for (const dir of old) expect(existsSync(dir)).toBe(false);
  expect(existsSync(fresh)).toBe(true);
  expect(existsSync(unrelated)).toBe(true);
});

test("sweepUsageState never follows a symlinked parent or entry", async () => {
  const { pacerHome, home } = fakeCtx();
  const outside = join(home, "outside"), target = join(outside, ".pacer-usage-state-x");
  mkdirSync(target, { recursive: true }); aged(target);
  mkdirSync(join(pacerHome, "state"), { recursive: true });
  symlinkSync(outside, join(pacerHome, "cache"));
  symlinkSync(target, join(pacerHome, "state", ".pacer-usage-state-link"));
  expect(await sweepUsageState(pacerHome, Date.now() + 10 * 3600 * 1000)).toBe(0);
  expect(existsSync(target)).toBe(true);
});

test("sweepAtomicWriteTmps removes only hour-old atomic-write temp files in the cache", () => {
  const { pacerHome } = fakeCtx();
  const dir = join(pacerHome, "cache"); mkdirSync(dir, { recursive: true });
  const file = (name: string) => { const path = join(dir, name); writeFileSync(path, ""); return path; };
  const stale = [
    aged(file("claude-rate-limits.json.12496.tmp")),
    aged(file("claude-rate-limits.json.6400.3575f4cd-80d4-4e95-afad-f2281bb3fb57.tmp")),
    aged(file("claude-rate-limits.json.5b577fbc-f12e-4cf4-af3a-7a03cd3ad8d5.tmp")),
  ];
  const fresh = file("claude-rate-limits.json.9.0c9accce-8f4d-4ace-bf37-4c0578c83da4.tmp");
  const other = aged(file("notes.tmp"));
  expect(sweepAtomicWriteTmps(pacerHome)).toBe(3);
  for (const path of stale) expect(existsSync(path)).toBe(false);
  expect(existsSync(fresh)).toBe(true);
  expect(existsSync(other)).toBe(true);
});
