import { expect, test } from "bun:test";
import { mkdirSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { claudeCachePaths, readClaude } from "../src/usage/claude";
import { fakeCtx } from "./helpers";

const SAMPLE = {
  five_hour: { used_percentage: 2, resets_at: 1791643200 },
  seven_day: { used_percentage: 4, resets_at: "2026-10-17T05:00:00Z" },
  captured_at: 1791633891.03,
};

async function put(path: string, data: unknown, mtime: number) {
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(data));
  utimesSync(path, mtime, mtime);
}

test("reads weekly (paced) and 5h (unpaced) windows", async () => {
  const ctx = fakeCtx({ now: 1791640000 });
  await put(claudeCachePaths(ctx)[0], SAMPLE, 1791633891);
  const r = await readClaude(ctx);
  expect(r.error).toBeUndefined();
  expect(r.source).toBe("status-line");
  expect(r.stale).toBe(false);
  expect(r.capturedAt).toBeCloseTo(1791633891.03);
  expect(r.windows).toEqual([
    { name: "weekly", usedPct: 4, resetsAt: Date.parse("2026-10-17T05:00:00Z") / 1000, lengthS: 604800, paced: true },
    { name: "5h", usedPct: 2, resetsAt: 1791643200, lengthS: 18000, paced: false },
  ]);
});

test("prefers the newer of the pacer cache and the legacy budget file", async () => {
  const ctx = fakeCtx({ now: 1791640000 });
  const [pacerPath, legacyPath] = claudeCachePaths(ctx);
  expect(legacyPath).toBe(join(ctx.home, ".claude", "state", "budget", "claude.json"));
  await put(pacerPath, { ...SAMPLE, captured_at: 1000, seven_day: { used_percentage: 10, resets_at: 1792213200 } }, 3000);
  await put(legacyPath, { ...SAMPLE, captured_at: 2000, seven_day: { used_percentage: 20, resets_at: 1792213200 } }, 2000);
  expect((await readClaude(ctx)).windows[0].usedPct).toBe(20);
});

test("missing data is an error reading; freshness of old data is left to the engine", async () => {
  const ctx = fakeCtx({ now: 1791640000 });
  const none = await readClaude(ctx);
  expect(none.windows).toEqual([]);
  expect(none.error).toContain("no Claude rate-limit data");
  await put(claudeCachePaths(ctx)[0], { ...SAMPLE, captured_at: 1791640000 - 90000 }, 1);
  expect((await readClaude(ctx)).stale).toBe(false);
});
