import { expect, test } from "bun:test";
import { closeSync, openSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, gitRepo, realRun } from "./helpers";
import { CoreError } from "../src/core/errors";
import {
  getRun, insertRun, updateRun, workflowDatabase,
} from "../src/workflow/store";
import { ensureRunBranch, withMergeLock } from "../src/workflow/branch";
import { cleanupRun } from "../src/workflow/cleanup";

test("cleanupRun refuses a live (non-terminal) run", async () => {
  const ctx = fakeCtx({ run: realRun });
  const repo = gitRepo();
  workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/feat", version: 1, repo, brief: "b", stepMode: "plain" });
  await ensureRunBranch(ctx, run);
  expect(getRun(ctx, run.id)!.status).toBe("running");
  await expect(cleanupRun(ctx, run.id, {
    deleteBranch: false, expectRev: getRun(ctx, run.id)!.rev,
  })).rejects.toMatchObject({
    code: "not_allowed",
    message: expect.stringMatching(/terminal/i),
  } as Partial<CoreError>);
  expect(getRun(ctx, run.id)!.branch).toBeTruthy();
});

test("cleanupRun on a stopped run returns tip confirmation fields", async () => {
  const ctx = fakeCtx({ run: realRun });
  const repo = gitRepo();
  workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/feat", version: 1, repo, brief: "b", stepMode: "plain" });
  await ensureRunBranch(ctx, run);
  const branched = getRun(ctx, run.id)!;
  const tip = (await ctx.run(["git", "-C", repo, "rev-parse", branched.branch!], 10_000)).stdout.trim();
  const stopped = updateRun(ctx, run.id, branched.rev, { status: "stopped" });
  const cleaned = await cleanupRun(ctx, stopped.id, { deleteBranch: true, expectRev: stopped.rev });
  expect(cleaned.deleted_branch).toBe(branched.branch!);
  expect(cleaned.deleted_tip).toBe(tip);
});

test("withMergeLock timeout is CoreError unavailable when lock is held", async () => {
  const ctx = fakeCtx({ run: realRun });
  const runId = "run_timeoutxx";
  const lockDir = join(ctx.pacerHome, "orca");
  await Bun.write(join(lockDir, ".keep"), "");
  const lockFile = join(lockDir, `run-merge-${runId}.lock`);
  closeSync(openSync(lockFile, "wx"));
  utimesSync(lockFile, new Date(), new Date());

  await expect(withMergeLock(ctx, runId, async () => "ok", {
    timeoutMs: 120, staleMs: 60_000,
  })).rejects.toMatchObject({
    code: "unavailable",
    message: expect.stringMatching(/merge lock timed out/),
  } as Partial<CoreError>);
});

test("R2-F7: withMergeLock takes over a stale lock and runs", async () => {
  const ctx = fakeCtx({ run: realRun });
  const runId = "run_staletake1";
  const lockDir = join(ctx.pacerHome, "orca");
  await Bun.write(join(lockDir, ".keep"), "");
  const lockFile = join(lockDir, `run-merge-${runId}.lock`);
  closeSync(openSync(lockFile, "wx"));
  // Older than MERGE_LOCK_STALE_MS (420s): set mtime 500s ago.
  const old = new Date(Date.now() - 500_000);
  utimesSync(lockFile, old, old);

  const result = await withMergeLock(ctx, runId, async () => "took-over");
  expect(result).toBe("took-over");
});
