import { expect, test } from "bun:test";
import { appendFile, mkdir, readFile, rename, stat, truncate, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildActivity, hourBin } from "../src/pace/activity";
import { lastRateLimits, readCodex, windowsFromRateLimits } from "../src/usage/codex";
import { fakeCtx } from "./helpers";
import type { Ctx } from "../src/types";

const stamp = (ts: number) => JSON.stringify({ timestamp: new Date(ts * 1000).toISOString() });
const quota = (used: number) => JSON.stringify({ rate_limits: { primary: { used_percent: used, window_minutes: 10080 } } });

// Independent reference: the original full-text timestamp computation.
async function fullActivity(ctx: Ctx, paths: string[], lookbackDays = 28) {
  const hours = new Set<number>();
  for (const path of paths) {
    if ((await stat(path)).mtimeMs / 1000 < ctx.now - lookbackDays * 86400) continue;
    for (const m of (await readFile(path, "utf8")).matchAll(/"timestamp":"([^"]+)"/g)) {
      const ts = Date.parse(m[1]) / 1000;
      if (ts >= ctx.now - lookbackDays * 86400 && ts <= ctx.now) hours.add(Math.floor(ts / 3600));
    }
  }
  const bins = Array<number>(168).fill(0), dates = new Set<string>();
  for (const h of hours) { bins[hourBin(h * 3600)]++; dates.add(new Date(h * 3600000).toDateString()); }
  const max = Math.max(0, ...bins);
  return { builtAt: ctx.now, days: dates.size, bins, active: bins.map(b => max > 0 && b >= 0.2 * max) };
}

test("activity cursors equal full scans after append, partial timestamp, truncation, rotation and new logs", async () => {
  const ctx = fakeCtx();
  const dir = join(ctx.home, ".claude/projects/project");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "a.jsonl"), second = join(dir, "new.jsonl");
  let paths = [path];
  const check = async () => expect(await buildActivity(ctx)).toEqual(await fullActivity(ctx, paths));
  await writeFile(path, stamp(ctx.now - 3600));
  await check(); await check();
  await appendFile(path, "\n" + stamp(ctx.now - 86400));
  await check();
  const split = stamp(ctx.now - 2 * 86400);
  await appendFile(path, "\n" + split.slice(0, 22));
  await check();
  await appendFile(path, split.slice(22));
  await check();
  await truncate(path, 0);
  await appendFile(path, stamp(ctx.now - 7200));
  await check();
  await rename(path, path + ".old");
  await writeFile(path, stamp(ctx.now - 3 * 86400));
  await check();
  await writeFile(second, stamp(ctx.now - 4 * 86400));
  paths.push(second); await check();
  await utimes(second, ctx.now - 40 * 86400, ctx.now - 40 * 86400);
  await check();
  const state = join(ctx.pacerHome, "state/activity-cursors.json");
  expect((await stat(state)).mode & 0o777).toBe(0o600);
  expect((await readFile(state, "utf8")).includes("timestamp")).toBe(false);
});

test("activity cursor boundaries advance exactly and readonly creates no state", async () => {
  const ctx = { ...fakeCtx(), readOnly: true };
  const dir = join(ctx.home, ".codex/sessions");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "rollout-a.jsonl");
  await writeFile(path, [stamp(ctx.now - 86400), stamp(ctx.now + 1)].join("\n"));
  expect(await buildActivity(ctx)).toEqual(await fullActivity(ctx, [path]));
  const later = { ...ctx, now: ctx.now + 2 };
  expect(await buildActivity(later, { lookbackDays: 1 })).toEqual(await fullActivity(later, [path], 1));
  expect(await Bun.file(join(ctx.pacerHome, "state/activity-cursors.json")).exists()).toBe(false);
});

test("Codex cursors equal tail scan after append, partial line, truncation, replacement and tail expiry", async () => {
  const ctx = fakeCtx();
  const dir = join(ctx.home, ".codex/sessions");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "rollout-a.jsonl");
  const check = async () => {
    const rl = await lastRateLimits(path);
    const reading = await readCodex(ctx);
    if (rl) expect(reading.windows).toEqual(windowsFromRateLimits(rl, (await stat(path)).mtimeMs / 1000));
    else expect(reading.error).toContain("no rate_limits");
  };
  await writeFile(path, quota(1)); await check(); await check();
  await appendFile(path, "\n" + quota(2)); await check();
  await appendFile(path, "\n" + quota(3).slice(0, 24)); await check();
  await appendFile(path, quota(3).slice(24)); await check();
  // A valid non-newline record becomes invalid when bytes are appended to it.
  await appendFile(path, "invalid"); await check();
  await truncate(path, 0); await appendFile(path, quota(4) + "\n"); await check();
  await rename(path, path + ".old"); await writeFile(path, quota(5) + "\n"); await check();
  await appendFile(path, "x".repeat(4_000_010)); await check();
  const newer = join(dir, "rollout-new.jsonl");
  await writeFile(newer, quota(9)+"\n");
  await utimes(newer, ctx.now + 10, ctx.now + 10);
  expect((await readCodex(ctx)).windows[0].usedPct).toBe(9);
});

test("persisted cursors are usable in another process without reading unchanged file contents", async () => {
  const ctx = fakeCtx();
  const dir = join(ctx.home, ".claude/projects/project");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "a.jsonl"), stamp(ctx.now - 3600));
  const codexDir = join(ctx.home, ".codex/sessions");
  await mkdir(codexDir, { recursive: true });
  await writeFile(join(codexDir, "rollout-a.jsonl"), quota(7)+"\n");
  const expectedQuota = await readCodex(ctx);
  const expected = await buildActivity(ctx);
  // A fresh module/process loads persisted state; unchanged source files need no data reads.
  const script = `import { buildActivity } from ${JSON.stringify(new URL("../src/pace/activity.ts", import.meta.url).pathname)};
    import { makeCtx } from ${JSON.stringify(new URL("../src/ctx.ts", import.meta.url).pathname)};
    import { readCodex } from ${JSON.stringify(new URL("../src/usage/codex.ts", import.meta.url).pathname)};
    import { spyOn } from "bun:test";
    import * as fs from "node:fs/promises";
    const realOpen = fs.open;
    spyOn(fs, "open").mockImplementation((...args) => {
      if (String(args[0]).endsWith(".jsonl")) throw Error("unchanged log opened");
      return realOpen(...args);
    });
    const ctx = {...makeCtx(), now: ${ctx.now}, readOnly: true};
    console.log(JSON.stringify({profile: await buildActivity(ctx), quota: await readCodex(ctx)}));`;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: { ...process.env, HOME: ctx.home, PACER_HOME: ctx.pacerHome }, stdout: "pipe", stderr: "pipe",
  });
  expect(await child.exited).toBe(0);
  expect(JSON.parse(await new Response(child.stdout).text())).toEqual({profile: expected, quota: expectedQuota});
});


test("activity scans across byte boundaries and reads only the suffix after an append", async () => {
  const ctx = fakeCtx();
  const dir = join(ctx.home, ".claude/projects/project");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "a.jsonl");
  await writeFile(path, "é".repeat(131069) + stamp(ctx.now - 3600));
  expect(await buildActivity(ctx)).toEqual(await fullActivity(ctx, [path]));
  const statePath = join(ctx.pacerHome, "state/activity-cursors.json");
  const before = JSON.parse(await readFile(statePath, "utf8")).files[path];
  expect(before.offset).toBeGreaterThan(256000);
  const suffix = "\n" + stamp(ctx.now - 86400);
  await appendFile(path, suffix);
  expect(await buildActivity(ctx)).toEqual(await fullActivity(ctx, [path]));
  const after = JSON.parse(await readFile(statePath, "utf8")).files[path];
  expect(after.size - before.offset).toBeLessThan(Buffer.byteLength(suffix) + 20);
});

test("invalid persisted cursor entries are rebuilt", async () => {
  const ctx = fakeCtx();
  const dir = join(ctx.home, ".claude/projects/project");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "a.jsonl");
  await writeFile(path, stamp(ctx.now - 3600));
  const stateDir = join(ctx.pacerHome, "state");
  await mkdir(stateDir, { recursive: true });
  const info = await stat(path);
  await writeFile(join(stateDir, "activity-cursors.json"), JSON.stringify({ version: 1, files: {
    [path]: { size: info.size, mtime: info.mtimeMs, inode: info.ino, offset: info.size, aggregate: "broken" },
  } }));
  expect(await buildActivity(ctx)).toEqual(await fullActivity(ctx, [path]));
});

test("50k activity timestamps persist as compact hourly ranges and prune expired hours", async () => {
  const ctx = fakeCtx();
  const dir = join(ctx.home, ".claude/projects/project");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "large.jsonl");
  await writeFile(path, Array.from({ length: 50_000 }, (_, i) => stamp(ctx.now - i * 60)).join("\n"));
  expect(await buildActivity(ctx)).toEqual(await fullActivity(ctx, [path]));
  const statePath = join(ctx.pacerHome, "state/activity-cursors.json");
  expect((await stat(statePath)).size).toBeLessThan(64 * 1024);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  expect(state.version).toBe(2);
  const hours = Object.keys(state.files[path].aggregate).map(Number);
  expect(hours.length).toBeLessThanOrEqual(673);
  expect(Math.min(...hours)).toBe(Math.floor((ctx.now - 28 * 86400) / 3600));
  // Changing lookback must recover timestamps that were pruned from the cache.
  expect(await buildActivity(ctx, { lookbackDays: 40 })).toEqual(await fullActivity(ctx, [path], 40));
  const later = { ...ctx, now: ctx.now + 2 * 86400 };
  expect(await buildActivity(later)).toEqual(await fullActivity(later, [path]));
  const aged = JSON.parse(await readFile(statePath, "utf8"));
  expect(Math.min(...Object.keys(aged.files[path].aggregate).map(Number)))
    .toBe(Math.floor((later.now - 28 * 86400) / 3600));
});

test("sparse hourly ranges preserve both boundaries, including gaps in a single minute", async () => {
  const base = fakeCtx();
  const hour = Math.floor(base.now / 3600) * 3600;
  const ctx = { ...base, now: hour + 30 };
  const dir = join(ctx.home, ".claude/projects/project");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "sparse.jsonl");
  await writeFile(path, [hour + 10, hour + 50, hour - 86400 + 10, hour - 86400 + 50].map(stamp).join("\n"));
  for (const lookbackDays of [1, 10 / 86400, 20 / 86400, 40 / 86400]) {
    expect(await buildActivity(ctx, { lookbackDays })).toEqual(await fullActivity(ctx, [path], lookbackDays));
  }
  const later = { ...ctx, now: hour + 51 };
  expect(await buildActivity(later, { lookbackDays: 20 / 86400 }))
    .toEqual(await fullActivity(later, [path], 20 / 86400));
});

test("version one timestamp arrays are discarded and rebuilt", async () => {
  const ctx = fakeCtx();
  const dir = join(ctx.home, ".claude/projects/project");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "old.jsonl");
  await writeFile(path, stamp(ctx.now - 3600));
  const info = await stat(path);
  const stateDir = join(ctx.pacerHome, "state");
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, "activity-cursors.json"), JSON.stringify({ version: 1, files: {
    [path]: { size: info.size, mtime: info.mtimeMs, inode: info.ino, offset: info.size, aggregate: [] },
  } }));
  expect(await buildActivity(ctx)).toEqual(await fullActivity(ctx, [path]));
  expect(JSON.parse(await readFile(join(stateDir, "activity-cursors.json"), "utf8")).version).toBe(2);
});
