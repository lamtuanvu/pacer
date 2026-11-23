import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, gitRepo, realRun, tmpDir } from "./helpers";
import { readActivity } from "../src/activity/log";
import { gitInfo } from "../src/core/git";
import { getRun, insertRun, workflowDatabase } from "../src/workflow/store";
import {
  ensureRunBranch, integrationWorktree, integrationWorktreePath, withMergeLock,
} from "../src/workflow/branch";
import { awaitTerminalSettle, settleRunGitAfterTerminal, stopRun } from "../src/workflow/engine";

async function seededWithIntegration() {
  const repo = gitRepo();
  const bare = join(tmpDir(), "origin.git");
  const ctx = fakeCtx({ run: realRun });
  expect((await ctx.run(["git", "clone", "--bare", "-q", repo, bare], 30_000)).code).toBe(0);
  expect((await ctx.run(["git", "-C", repo, "remote", "add", "origin", bare], 10_000)).code).toBe(0);
  workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/feat", version: 1, repo, brief: "b", stepMode: "plain" });
  await ensureRunBranch(ctx, run);
  const live = getRun(ctx, run.id)!;
  const wt = await integrationWorktree(ctx, live);
  expect(existsSync(wt)).toBe(true);
  return { ctx, repo, run: getRun(ctx, run.id)! };
}

test("stop returns promptly while merge lock is held; settle completes after release", async () => {
  const { ctx, repo, run } = await seededWithIntegration();
  const top = await gitInfo(ctx.run, repo);
  if ("error" in top) throw new Error(top.error);
  const wtPath = integrationWorktreePath(ctx, top.top, run.id);
  expect(existsSync(wtPath)).toBe(true);

  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const holder = withMergeLock(ctx, run.id, async () => {
    await held;
    return "held";
  });

  const live = getRun(ctx, run.id)!;
  const started = Date.now();
  const stopped = await stopRun(ctx, live.id, live.rev);
  const elapsedMs = Date.now() - started;
  expect(stopped.status).toBe("stopped");
  expect(getRun(ctx, run.id)!.status).toBe("stopped");
  // Must not wait on the 150 s merge-lock timeout (was blocking stop behind publish).
  expect(elapsedMs).toBeLessThan(5_000);

  release();
  await holder;
  await awaitTerminalSettle(run.id);
  expect(existsSync(wtPath)).toBe(false);
});

test("failed terminal settle is reported in activity, not swallowed", async () => {
  const { ctx, run } = await seededWithIntegration();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const holder = withMergeLock(ctx, run.id, async () => {
    await held;
    return "held";
  });

  // Short lock timeout so the bounded retry exhausts without waiting 150 s.
  await settleRunGitAfterTerminal(ctx, run, { timeoutMs: 200 });
  const { entries } = readActivity(ctx, { kinds: ["task_settled"], limit: 20 });
  expect(entries.some(e =>
    e.level === "warn" && e.text.includes(run.id) && /terminal settle failed/i.test(e.text),
  )).toBe(true);

  release();
  await holder;
});
