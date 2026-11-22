import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, gitRepo, realRun, tmpDir } from "./helpers";
import { createTask } from "../src/tasks/store";
import type { DelegateInput } from "../src/tasks/api";
import type { TaskRecord } from "../src/tasks/types";
import { readTask, updateTask } from "../src/tasks/store";
import { addDefinition, getRun, insertRun, workflowDatabase } from "../src/workflow/store";
import {
  ensureRunBranch, integrationWorktree, isCodeStep, runBranchName, withMergeLock,
} from "../src/workflow/branch";
import { startRun, type EngineDeps } from "../src/workflow/engine";
import type { WorkflowDef } from "../src/workflow/schema";
import { taskWorktreesDir } from "../src/supervisor/worktree";

function gitCtx(repo?: string) {
  const ctx = fakeCtx({ run: realRun });
  return { ctx, repo: repo ?? gitRepo() };
}

test("runBranchName uses the 10 base32 chars of the run id", () => {
  expect(runBranchName("run_abcdefghij")).toBe("pacer/run-abcdefghij");
});

test("isCodeStep: research/docs/review default off; feature on; code flag overrides", () => {
  expect(isCodeStep({ kind: "research" })).toBe(false);
  expect(isCodeStep({ kind: "docs" })).toBe(false);
  expect(isCodeStep({ kind: "unfamiliar-code" })).toBe(false);
  expect(isCodeStep({ kind: "review" })).toBe(false);
  expect(isCodeStep({ kind: "feature" })).toBe(true);
  expect(isCodeStep({ kind: "tests" })).toBe(true);
  expect(isCodeStep({ kind: "research", code: true })).toBe(true);
  expect(isCodeStep({ kind: "feature", code: false })).toBe(false);
  expect(isCodeStep({ role: "orchestrator" })).toBe(false);
});

test("ensureRunBranch creates pacer/run-* from base tip without checking it out", async () => {
  const { ctx, repo } = gitCtx();
  workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/b", version: 1, repo, brief: "b" });
  const tip = (await ctx.run(["git", "-C", repo, "rev-parse", "HEAD"], 10_000)).stdout.trim();
  const ensured = await ensureRunBranch(ctx, run);
  expect(ensured.branch).toBe(runBranchName(run.id));
  expect(ensured.base_sha).toBe(tip);
  expect(ensured.base_ref).toBeTruthy();
  const stored = getRun(ctx, run.id)!;
  expect(stored.branch).toBe(ensured.branch);
  expect(stored.baseSha).toBe(tip);
  // Repo checkout stays on main; the run branch exists as a ref.
  const head = (await ctx.run(["git", "-C", repo, "rev-parse", "--abbrev-ref", "HEAD"], 10_000)).stdout.trim();
  expect(head).toBe("main");
  const has = await ctx.run(["git", "-C", repo, "rev-parse", "--verify", ensured.branch], 10_000);
  expect(has.code).toBe(0);
  expect(has.stdout.trim()).toBe(tip);
});

test("ensureRunBranch is a no-op when the run already has a branch (concurrent-safe)", async () => {
  const { ctx, repo } = gitCtx();
  workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/b", version: 1, repo, brief: "b" });
  const [a, b] = await Promise.all([ensureRunBranch(ctx, run), ensureRunBranch(ctx, run)]);
  expect(a.branch).toBe(b.branch);
  expect(a.base_sha).toBe(b.base_sha);
  const branches = (await ctx.run(["git", "-C", repo, "branch", "--list", a.branch], 10_000)).stdout.trim().split("\n").filter(Boolean);
  expect(branches).toHaveLength(1);
});

test("integrationWorktree lives under the task worktrees directory on the run branch", async () => {
  const { ctx, repo } = gitCtx();
  workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/b", version: 1, repo, brief: "b" });
  await ensureRunBranch(ctx, run);
  const path = await integrationWorktree(ctx, run);
  expect(path.startsWith(taskWorktreesDir(ctx) + "/")).toBe(true);
  expect(existsSync(path)).toBe(true);
  const branch = (await ctx.run(["git", "-C", path, "rev-parse", "--abbrev-ref", "HEAD"], 10_000)).stdout.trim();
  expect(branch).toBe(runBranchName(run.id));
  // Second call reuses the same path.
  expect(await integrationWorktree(ctx, run)).toBe(path);
});

test("withMergeLock serializes concurrent critical sections per run", async () => {
  const ctx = fakeCtx({ run: realRun });
  const order: number[] = [];
  await Promise.all([
    withMergeLock(ctx, "run_aaaaaaaaaa", async () => {
      order.push(1);
      await Bun.sleep(30);
      order.push(2);
    }),
    withMergeLock(ctx, "run_aaaaaaaaaa", async () => {
      order.push(3);
      order.push(4);
    }),
  ]);
  expect(order).toEqual([1, 2, 3, 4]);
});

test("a run with only non-code steps never gets a branch", async () => {
  const { ctx, repo } = gitCtx();
  const def: WorkflowDef = {
    id: "t/ask",
    version: 1,
    steps: {
      ask: { type: "agent", kind: "research", prompt: "Explore" },
      done: { type: "end" },
    },
    edges: [{ from: "ask", to: "done" }],
    entry: "ask",
  };
  addDefinition(ctx, def, "src");
  const inputs: DelegateInput[] = [];
  const byRequest = new Map<string, TaskRecord>();
  const deps: EngineDeps = {
    delegate: async (c, input) => {
      inputs.push(input);
      const prior = input.requestId ? byRequest.get(input.requestId) : undefined;
      if (prior) return readTask(c, prior.id) ?? prior;
      const task = createTask(c, {
        brief: input.brief, kind: input.kind ?? null, requestedExecutor: null, timeoutS: 600,
        ...(input.requestId ? { requestId: input.requestId } : {}),
      });
      if (input.requestId) byRequest.set(input.requestId, task);
      return task;
    },
    stopTask: (c, id) => updateTask(c, id, t => { t.state = "stopped"; }),
  };
  const run = await startRun(ctx, { workflow: "t/ask", repo, brief: "explore" }, undefined, deps);
  expect(getRun(ctx, run.id)!.branch).toBeUndefined();
  expect(inputs[0]?.brief.base).toBeUndefined();
});

test("a code step delegates with brief.base = run branch tip", async () => {
  const { ctx, repo } = gitCtx();
  const def: WorkflowDef = {
    id: "t/feat",
    version: 1,
    steps: {
      impl: { type: "agent", kind: "feature", prompt: "Implement" },
      done: { type: "end" },
    },
    edges: [{ from: "impl", to: "done" }],
    entry: "impl",
  };
  addDefinition(ctx, def, "src");
  const inputs: DelegateInput[] = [];
  const byRequest = new Map<string, TaskRecord>();
  const deps: EngineDeps = {
    delegate: async (c, input) => {
      inputs.push(input);
      const prior = input.requestId ? byRequest.get(input.requestId) : undefined;
      if (prior) return readTask(c, prior.id) ?? prior;
      const task = createTask(c, {
        brief: input.brief, kind: input.kind ?? null, requestedExecutor: null, timeoutS: 600,
        ...(input.requestId ? { requestId: input.requestId } : {}),
      });
      if (input.requestId) byRequest.set(input.requestId, task);
      return task;
    },
    stopTask: (c, id) => updateTask(c, id, t => { t.state = "stopped"; }),
  };
  const run = await startRun(ctx, { workflow: "t/feat", repo, brief: "build" }, undefined, deps);
  const stored = getRun(ctx, run.id)!;
  expect(stored.branch).toBe(runBranchName(run.id));
  expect(inputs[0]?.brief.base).toBe(stored.branch);
  // Worktree base resolution would start at the run branch tip.
  const tip = (await ctx.run(["git", "-C", repo, "rev-parse", stored.branch!], 10_000)).stdout.trim();
  expect(stored.baseSha).toBe(tip);
});

test("serialized merges under the merge lock under contention", async () => {
  const { ctx, repo } = gitCtx();
  workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/b", version: 1, repo, brief: "b" });
  await ensureRunBranch(ctx, run);
  const wt = await integrationWorktree(ctx, run);
  // Two side branches with distinct commits.
  for (const name of ["pacer/t-a", "pacer/t-b"]) {
    await ctx.run(["git", "-C", repo, "branch", name, "HEAD"], 10_000);
    const side = join(tmpDir(), name.replace("/", "-"));
    await ctx.run(["git", "-C", repo, "worktree", "add", "-q", side, name], 60_000);
    await Bun.write(join(side, `${name}.txt`), name);
    await ctx.run(["git", "-C", side, "add", "."], 10_000);
    await ctx.run(["git", "-C", side, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", name], 10_000);
  }
  const merges: string[] = [];
  await Promise.all(["pacer/t-a", "pacer/t-b"].map(branch => withMergeLock(ctx, run.id, async () => {
    const r = await ctx.run(["git", "-C", wt, "merge", "--no-ff", "--no-edit", "-m", `merge ${branch}`, branch], 60_000);
    expect(r.code).toBe(0);
    merges.push(branch);
  })));
  expect(merges.sort()).toEqual(["pacer/t-a", "pacer/t-b"]);
  const log = (await ctx.run(["git", "-C", wt, "log", "--oneline", runBranchName(run.id)], 10_000)).stdout;
  expect(log).toContain("pacer/t-a");
  expect(log).toContain("pacer/t-b");
});
