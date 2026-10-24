import { expect, test } from "bun:test";
import { readByteplus as originalByteplus } from "../src/usage/byteplus";
import { readMetered as originalMetered } from "../src/usage/metered";
import { readClaude as originalClaude, claudeCachePaths } from "../src/usage/claude";
import { cachedFetch } from "../src/usage/cache";
import { fakeCtx } from "./helpers";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import * as byteplus from "../plugins/pacer-usage/byteplus";
import * as metered from "../plugins/pacer-usage/metered";
import * as claude from "../plugins/pacer-usage/claude";
import type { ReaderContext } from "../plugins/pacer-usage/reader-types";
import type { ProviderCfg } from "../src/config/strategy";

const now = 1791633600;
const cfg: ProviderCfg = { id: "opencode#paid", via: "opencode", model: "public/code", usage: "metered",
  allowPaid: false, cooldownS: 0, quotaSource: null, weeklyTokens: null, weeklyUsd: 100 };
function context(ctx: ReturnType<typeof fakeCtx>): ReaderContext {
  return { now: ctx.now, readOnly: ctx.readOnly, io: {
    run: ctx.run,
    cachedFetch: (key, ttl, stale, fetcher, options) => cachedFetch(ctx, key, ttl, stale, fetcher, options),
    read: async path => { const file = Bun.file(path); return await file.exists() ? { text: await file.text(), mtime: file.lastModified } : null; },
  } as ReaderContext["io"] };
}

test("plugin arkcli preserves subscription availability, rich windows, and exact argv", async () => {
  expect(typeof byteplus.readByteplus).toBe("function");
  for (const payload of [{ items: [] }, { items: [{ product: "coding-plan", subscribed: false }] }, {},
    { items: [{ product: "coding-plan", subscribed: true, periods: [
      { label: "session", percent: 12, reset_at: now + 100 }, { label: "weekly", percent: 30, reset_at: now + 200 },
      { label: "monthly", percent: 50, reset_at: "2026-03-31T00:00:00Z" }] }] }]) {
    const calls: unknown[] = [];
    const run = async (argv: string[], timeout: number) => { calls.push([argv, timeout]); return { code: 0, stdout: JSON.stringify(payload), stderr: "" }; };
    const ctx = { ...fakeCtx({ now, run }), readOnly: true };
    expect(await byteplus.readByteplus(context(ctx), true)).toEqual(await originalByteplus(ctx, true));
    expect(calls).toEqual(Array(2).fill([["arkcli", "usage", "plan", "--product", "coding-plan"], 8000]));
  }
});

test("plugin metered preserves dollar/token budgets, incomplete errors and failed-command errors", async () => {
  expect(typeof metered.readMetered).toBe("function");
  for (const payload of [{}, { models: [] }, { models: [{ model: { providerID: "public", id: "code" }, tokens: { input: 10 }, cost: 25 }] },
    { models: [{ model: { providerID: "public", id: "code" }, tokens: { input: 10 } }] }]) {
    for (const budget of [cfg, { ...cfg, weeklyUsd: null, weeklyTokens: 100 }, { ...cfg, model: null }]) {
      const ctx = { ...fakeCtx({ now, run: async () => ({ code: 0, stdout: JSON.stringify(payload), stderr: "" }) }), readOnly: true };
      expect(await metered.readMetered(context(ctx), budget, true)).toEqual(await originalMetered(ctx, budget, true));
    }
  }
  const ctx = { ...fakeCtx({ now, run: async () => ({ code: 3, stdout: "", stderr: "synthetic offline" }) }), readOnly: true };
  expect(await metered.readMetered(context(ctx), cfg, true)).toEqual(await originalMetered(ctx, cfg, true));
});

test("plugin Claude uses host-selected files, newest nonfuture snapshot, and source metadata", async () => {
  expect(typeof claude.readClaude).toBe("function");
  const ctx = fakeCtx({ now });
  const paths = claudeCachePaths(ctx);
  const pluginCtx = { ...context(ctx), resources: { claudeFiles: paths } };
  expect(await claude.readClaude(pluginCtx)).toEqual(await originalClaude(ctx));
  for (const [index, captured_at] of [[0, now - 10], [1, now - 5]] as const) {
    await mkdir(dirname(paths[index]), { recursive: true });
    await writeFile(paths[index], JSON.stringify({ captured_at, source: index ? "session-log" : "status-line", seven_day: { used_percentage: 20 }, five_hour: { used_percentage: 5 } }));
  }
  expect(await claude.readClaude(pluginCtx)).toEqual(await originalClaude(ctx));
  await writeFile(paths[1], JSON.stringify({ captured_at: now + 1 }));
  expect(await claude.readClaude(pluginCtx)).toEqual(await originalClaude(ctx));
});

import { readCodex as originalCodex } from "../src/usage/codex";
import { CursorStore } from "../src/usage/cursors";
import { readCodex } from "../plugins/pacer-usage/codex";
import { appendFile, stat, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { FileInfo } from "../plugins/pacer-usage/reader-types";

function codexContext(ctx: ReturnType<typeof fakeCtx>): ReaderContext {
  const stores = new Map<string, CursorStore<unknown>>();
  const info = async (path: string): Promise<FileInfo> => {
    const s = await stat(path); return { path, size: s.size, mtimeMs: s.mtimeMs, inode: s.ino, device: s.dev };
  };
  const result = context(ctx);
  result.resources = { codexSessions: join(ctx.home, ".codex", "sessions") };
  result.io.stat = async path => { try { return await info(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; } };
  result.io.list = async (root, glob) => {
    const files = [];
    for await (const path of new Bun.Glob(glob).scan({ cwd: root, absolute: true })) files.push(await info(path));
    return files;
  };
  result.io.range = async (path, offset, length, expected) => {
    expect(length).toBeLessThanOrEqual(256 * 1024);
    const current = await info(path);
    expect(current).toEqual(expected);
    const bytes = new Uint8Array(await Bun.file(path).slice(offset, offset + length).arrayBuffer());
    return { bytes, info: current };
  };
  result.io.cursors = async (key, version, valid, action) => {
    let store = stores.get(key);
    if (!store) { store = new CursorStore(join(ctx.pacerHome, "state", "plugin-cursors.json"), valid, version); stores.set(key, store); }
    return store.run(ctx, action as Parameters<typeof store.run>[1]) as ReturnType<typeof action>;
  };
  return result;
}
const event = (used: number, at = now, balance = "12.5") => JSON.stringify({ timestamp: at,
  payload: { rate_limits: { primary: { used_percent: used, window_minutes: 10080, resets_in_seconds: 3600 },
    credits: { has_credits: true, balance } } } });

test("plugin Codex preserves >4MiB tails, rich equal-time conflicts, provisional lines and incremental appends", async () => {
  const ctx = { ...fakeCtx({ now: now + 60 }), readOnly: true };
  const io = codexContext(ctx);
  const dir = io.resources!.codexSessions!;
  await mkdir(dir, { recursive: true });
  const path = join(dir, "rollout-large.jsonl");
  await writeFile(path, JSON.stringify({ text: "é".repeat(2_100_000) }) + "\n" + event(25) + "\n" + event(40) + "\n" + event(99));
  expect(await readCodex(io)).toEqual(await originalCodex(ctx));
  await appendFile(path, "\n");
  expect(await readCodex(io)).toEqual(await originalCodex(ctx));
  await appendFile(path, event(75, now + 1000) + "\n");
  expect(await readCodex(io)).toEqual(await originalCodex(ctx));
  expect(await Bun.file(join(ctx.pacerHome, "state", "plugin-cursors.json")).exists()).toBe(false);
  await writeFile(path, event(15) + "\n");
  expect(await readCodex(io)).toEqual(await originalCodex(ctx));
  await rename(path, path + ".old");
  await writeFile(path, event(33) + "\n");
  expect(await readCodex(io)).toEqual(await originalCodex(ctx));
});

test("plugin Codex preserves missing/empty logs and newest-15 fallback", async () => {
  const ctx = { ...fakeCtx({ now }), readOnly: true };
  const io = codexContext(ctx);
  expect(await readCodex(io)).toEqual(await originalCodex(ctx));
  const dir = io.resources!.codexSessions!;
  await mkdir(dir, { recursive: true });
  expect(await readCodex(io)).toEqual(await originalCodex(ctx));
  for (let i = 0; i < 16; i++) await writeFile(join(dir, `rollout-${i}.jsonl`), i ? "{}\n" : event(10) + "\n");
  expect(await readCodex(io)).toEqual(await originalCodex(ctx));
});

test("plugin Codex matches Buffer UTF8 semantics for BOM-prefixed JSONL records", async () => {
  const ctx = { ...fakeCtx({ now }), readOnly: true };
  const io = codexContext(ctx);
  await mkdir(io.resources!.codexSessions!, { recursive: true });
  await writeFile(join(io.resources!.codexSessions!, "rollout-bom.jsonl"), event(10) + "\n\uFEFF" + event(90) + "\n");
  expect(await readCodex(io)).toEqual(await originalCodex(ctx));
});

test("plugin provider caches preserve failed-refresh stale fallback and readOnly policy", async () => {
  for (const kind of ["arkcli", "metered"] as const) {
    let fail = false;
    const ctx = fakeCtx({ now, run: async () => fail
      ? { code: 2, stdout: "", stderr: "offline" }
      : { code: 0, stdout: JSON.stringify(kind === "arkcli"
        ? { items: [{ product: "coding-plan", subscribed: true, periods: [] }] }
        : { models: [{ model: { providerID: "public", id: "code" }, tokens: { input: 10 }, cost: 25 }] }), stderr: "" } });
    const read = async () => kind === "arkcli" ? byteplus.readByteplus(context(ctx), true) : metered.readMetered(context(ctx), cfg, true);
    const original = async () => kind === "arkcli" ? originalByteplus(ctx, true) : originalMetered(ctx, cfg, true);
    expect(await read()).toEqual(await original());
    const cachePath = join(ctx.pacerHome, "cache", kind === "arkcli" ? "arkcli-usage-plan.json" : "opencode-stats-7d-cost.json");
    const persisted = await readFile(cachePath, "utf8");
    fail = true;
    ctx.now++;
    ctx.readOnly = true;
    expect(await read()).toEqual(await original());
    expect(await readFile(cachePath, "utf8")).toBe(persisted);
  }
});

test("plugin Codex readOnly cursor state retries persistence without rereading unchanged source", async () => {
  const ctx = { ...fakeCtx({ now }), readOnly: true };
  const io = codexContext(ctx);
  await mkdir(io.resources!.codexSessions!, { recursive: true });
  const log = join(io.resources!.codexSessions!, "rollout-retry.jsonl");
  await writeFile(log, event(10) + "\n");
  const expected = await originalCodex(ctx);
  expect(await readCodex(io)).toEqual(expected);
  const originalRange = io.io.range;
  let reads = 0;
  io.io.range = async (...args) => { reads++; return originalRange(...args); };
  ctx.readOnly = false;
  io.readOnly = false;
  expect(await readCodex(io)).toEqual(expected);
  expect(reads).toBe(0);
  const snapshot = JSON.parse(await readFile(join(ctx.pacerHome, "state", "plugin-cursors.json"), "utf8"));
  expect(snapshot.version).toBe(4);
  expect(snapshot.files[log].offset).toBe((await stat(log)).size);
});
