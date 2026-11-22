import { expect, test } from "bun:test";
import { closeSync, openSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, gitRepo, realRun } from "./helpers";
import { CoreError } from "../src/core/errors";
import {
  getRun, insertRun, updateRun, workflowDatabase,
} from "../src/workflow/store";
import { ensureRunBranch } from "../src/workflow/branch";
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

test("merge lock timeout is projected as CoreError unavailable", async () => {
  const ctx = fakeCtx({ run: realRun });
  const lockDir = join(ctx.pacerHome, "orca");
  await Bun.write(join(lockDir, ".keep"), "");
  const lockFile = join(lockDir, "run-merge-run_timeoutxx.lock");
  closeSync(openSync(lockFile, "wx"));
  utimesSync(lockFile, new Date(), new Date());

  const { withLock } = await import("../src/core/lock");
  await expect(withLock(ctx, "run-merge-run_timeoutxx", async () => "ok", {
    timeoutMs: 100, staleMs: 60_000,
  })).rejects.toThrow(/timed out/);

  // withMergeLock wraps that plain Error as CoreError('unavailable').
  const err = new Error(`timed out waiting for ${lockFile}`);
  expect(/^timed out waiting for /.test(err.message)).toBe(true);
  expect(new CoreError("unavailable", "merge lock timed out for run_timeoutxx")).toMatchObject({
    code: "unavailable",
  });
});
