import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { route } from "../core/routing";
import { delegate } from "../core/tasks";
import { CoreError, toCoreError } from "../core/errors";
import { withLock } from "../core/lock";
import { isExecutorSession } from "../install/role";
import { EXECUTOR_DELEGATE_ERROR, type SpawnRunner } from "../tasks/api";
import type { Ctx } from "../types";

const README = `# Your first pacer delegation

pacer connects a planner with your available executors.
The planner decides what to do and reviews the result.
Executors carry out focused tasks from a written brief.
pacer ranks executors using routing rules and available budgets.
This scratch repository is a safe place to try that workflow.
Its README is the input for a tiny documentation task.
The executor will summarize it in SUMMARY.md.
An acceptance command checks that the summary exists.
You can follow the task in pacer and inspect its diff.
Accept or reject the result to complete your first review.
For future work, give your planner a goal and let it delegate.
`;
export interface TryDeps { route?: typeof route; delegate?: typeof delegate; spawnRunner?: SpawnRunner }
export interface TryResult { task_id: string; executor: string; repo: string }

/** The fixed exercise uses the same routing, task runner and review flow as real work. */
export async function tryDelegation(ctx: Ctx, deps: TryDeps = {}): Promise<TryResult> {
  if (isExecutorSession(ctx)) throw new CoreError("not_allowed", EXECUTOR_DELEGATE_ERROR);
  try {
    return await withLock(ctx, "onboarding-try", async () => {
      const ranked = await (deps.route ?? route)(ctx, "docs");
      const executor = ranked.ranked[0]?.id;
      if (!executor) throw new CoreError("unknown_executor", "Add an executor first", "Run pacer runner add");
      const root = join(ctx.pacerHome, "onboarding");
      mkdirSync(root, {recursive: true, mode: 0o700});
      const repo = mkdtempSync(join(root, `try-${Math.floor(ctx.now * 1000)}-`));
      writeFileSync(join(repo, "README.md"), README);
      for (const args of [["init", "-q", "-b", "main"], ["add", "README.md"], ["-c", "user.name=pacer", "-c", "user.email=pacer@localhost", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "Initialize first delegation"]]) {
        const result = await ctx.run(["git", "-c", "core.hooksPath=/dev/null", "-C", repo, ...args], 10_000);
        if (result.code !== 0) throw new CoreError("invalid_input", "Could not create the first delegation repository", result.stderr.trim());
      }
      const task = (deps.delegate ?? delegate)(ctx, {
        source: "onboarding", kind: "docs", worktree: "current", timeoutMin: 15,
        brief: {repo, goal: "Summarize README.md in three bullet points into SUMMARY.md", acceptance: "test -s SUMMARY.md"},
      }, deps.spawnRunner);
      return {task_id: task.id, executor, repo};
    }, {timeoutMs: 0});
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("timed out waiting for")) throw new CoreError("conflict", "A first delegation is already starting");
    throw toCoreError(e);
  }
}
