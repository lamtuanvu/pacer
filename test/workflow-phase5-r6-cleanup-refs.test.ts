import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, gitRepo, realRun } from "./helpers";
import {
  getRun, insertRun, setRunBranch, workflowDatabase,
} from "../src/workflow/store";
import { ensureRunBranch } from "../src/workflow/branch";
import { runBranchAhead } from "../src/workflow/cleanup";

test("cleanup qualifies run.branch as refs/heads/ in rev-list and merge-base", () => {
  const src = readFileSync(join(import.meta.dir, "../src/workflow/cleanup.ts"), "utf8");
  expect(src).toMatch(/\$\{base\}\.\.refs\/heads\/\$\{run\.branch\}/);
  expect(src).toMatch(/refs\/heads\/\$\{branch\}/);
  expect(src).toMatch(/refs\/heads\/\$\{run\.branch\}/);
});

test("runBranchAhead uses refs/heads so a same-named tag cannot spoof ahead", async () => {
  const ctx = fakeCtx({ run: realRun });
  const repo = gitRepo();
  workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/feat", version: 1, repo, brief: "b", stepMode: "plain" });
  await ensureRunBranch(ctx, run);
  const live = getRun(ctx, run.id)!;
  const branch = live.branch!;
  const baseSha = live.baseSha!;
  const branchSha = (await ctx.run(
    ["git", "-C", repo, "rev-parse", "--verify", `refs/heads/${branch}`],
    10_000,
  )).stdout.trim();

  // Advance HEAD and tag the branch name at the new tip; leave the branch tip alone.
  await Bun.write(join(repo, "ahead-tag.txt"), "x\n");
  await ctx.run(["git", "-C", repo, "add", "."], 10_000);
  await ctx.run(["git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "tagtip"], 10_000);
  const tagSha = (await ctx.run(["git", "-C", repo, "rev-parse", "HEAD"], 10_000)).stdout.trim();
  await ctx.run(["git", "-C", repo, "branch", "-f", branch, branchSha], 10_000);
  await ctx.run(["git", "-C", repo, "tag", "-f", branch, tagSha], 10_000);

  setRunBranch(ctx, live.id, { branch, base_ref: live.baseRef!, base_sha: baseSha });
  const ahead = await runBranchAhead(ctx, getRun(ctx, live.id)!);
  // Unqualified `${base}..${branch}` would count commits to the tag tip; qualified stays at 0.
  expect(ahead).toBe(0);
});
