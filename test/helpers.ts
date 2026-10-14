import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execProcess } from "../src/exec/process";
import type { Ctx, RunFn } from "../src/types";

// Every test temp dir lives under one root per test run; test/setup.ts (bunfig preload) removes it after all tests.
// Without this, each suite run left hundreds of dirs behind (some ~250 MB) and filled the disk.
// Bun's test runner fires no process "exit" event, so the cleanup has to be a global afterAll.
let root: string | null = null;
function testRoot(): string {
  root ??= mkdtempSync(join(tmpdir(), "pacer-test-"));
  return root;
}

/** Removes the run's temp root. PACER_KEEP_TEST_TMP=1 keeps it for debugging. */
export function cleanupTestRoot(): void {
  if (!root || process.env.PACER_KEEP_TEST_TMP) return;
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  root = null;
}

export function tmpDir(): string {
  return mkdtempSync(join(testRoot(), "t-"));
}

/** Unix seconds for a local wall-clock time (tests run with TZ=Asia/Ho_Chi_Minh). Month is 1-based. */
export function localTs(y: number, mo: number, d: number, h = 0, mi = 0): number {
  return new Date(y, mo - 1, d, h, mi, 0).getTime() / 1000;
}

export function fakeCtx(o: Partial<Ctx> = {}): Ctx {
  const home = o.home ?? tmpDir();
  return {
    home,
    pacerHome: o.pacerHome ?? join(home, ".pacer"),
    now: o.now ?? localTs(2026, 10, 10, 19, 0),
    env: o.env ?? {},
    run: o.run ?? (async () => ({ code: 127, stdout: "", stderr: "not available in tests" })),
    which: o.which ?? (() => "/usr/bin/fake"),
  };
}

/** A RunFn that really runs commands (git in temp repos). */
export const realRun: RunFn = (argv, timeoutMs, o) => execProcess({ argv, cwd: process.cwd(), env: { ...process.env, ...(o?.env ?? {}) }, timeoutMs });

/** A temp git repo with one commit on branch main. */
export function gitRepo(): string {
  const repo = tmpDir();
  Bun.spawnSync(["sh", "-c", "git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init"], { cwd: repo });
  return repo;
}
