import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, gitRepo, realRun, tmpDir } from "./helpers";
import { createTask, updateTask } from "../src/tasks/store";
import { createTaskWorktree } from "../src/supervisor/worktree";
import { gitInfo } from "../src/core/git";
import {
  getRun, insertRun, insertStep, workflowDatabase,
} from "../src/workflow/store";
import { ensureRunBranch, mergeTaskOnAccept } from "../src/workflow/branch";

test("accept-merge child env has no PACER_* (same allowlist as syncBase)", async () => {
  const repo = gitRepo();
  const bare = join(tmpDir(), "origin.git");
  const ctx = fakeCtx({ run: realRun });
  expect((await ctx.run(["git", "clone", "--bare", "-q", repo, bare], 30_000)).code).toBe(0);
  expect((await ctx.run(["git", "-C", repo, "remote", "add", "origin", bare], 10_000)).code).toBe(0);

  const envLog = join(ctx.home, "accept-merge-env.json");
  ctx.env = {
    ...ctx.env,
    PACER_RUN_GRANT: "prg_secret_wire",
    PACER_ROLE: "orchestrator",
    PATH: process.env.PATH,
    HOME: process.env.HOME,
  };
  const baseRun = ctx.run;
  ctx.run = async (argv, timeoutMs, o) => {
    if (argv[0] === "git" && argv.includes("merge") && argv.includes("--no-ff")) {
      writeFileSync(envLog, JSON.stringify(o?.env ?? {}));
    }
    return baseRun(argv, timeoutMs, o);
  };

  workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/feat", version: 1, repo, brief: "b", stepMode: "plain" });
  await ensureRunBranch(ctx, run);
  const live = getRun(ctx, run.id)!;

  const task = createTask(ctx, {
    brief: { goal: "impl", repo }, kind: "feature", requestedExecutor: null, timeoutS: 600,
  });
  insertStep(ctx, { runId: run.id, stepId: "impl", attempt: 1, taskId: task.id, status: "done" });
  const info = await gitInfo(ctx.run, repo);
  if ("error" in info) throw new Error(info.error);
  const wt = await createTaskWorktree(ctx, info, task.id, live.branch!);
  if ("error" in wt) throw new Error(wt.error);
  await Bun.write(join(wt.path, "a.txt"), "a");
  await ctx.run(["git", "-C", wt.path, "add", "."], 10_000);
  await ctx.run(["git", "-C", wt.path, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "a"], 10_000);
  updateTask(ctx, task.id, t => {
    t.state = "done";
    t.worktree = wt.path;
    t.baseSha = live.baseSha;
    t.result = { status: "done", executor: "codex", model: null, files: "a.txt", report: "", backend: "direct", worktree: wt.path };
  });

  const merge = await mergeTaskOnAccept(ctx, task.id);
  expect(merge).toEqual({ merged: true });
  expect(existsSync(envLog)).toBe(true);
  const env = JSON.parse(await Bun.file(envLog).text()) as Record<string, string | undefined>;
  expect(env.PACER_RUN_GRANT).toBeUndefined();
  expect(env.PACER_ROLE).toBeUndefined();
  expect(env.HOME).toBeTruthy();
  expect(env.PATH).toBeTruthy();
  expect(env.GIT_TERMINAL_PROMPT).toBe("0");
});
