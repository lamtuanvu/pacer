import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { appendActivity } from "../src/activity/log";
import { createTask, updateTask } from "../src/tasks/store";
import { fakeCtx, tmpDir } from "./helpers";

function fixture(delay: number) {
  let calls: string[][] = [], active = 0, peak = 0;
  const repo = tmpDir();
  mkdirSync(join(repo, ".git"));
  writeFileSync(join(repo, ".git", "HEAD"), "first-head\n");
  const ctx = fakeCtx({run: async (argv, timeout) => {
    calls.push(argv); active++; peak = Math.max(peak, active);
    expect(timeout).toBeLessThanOrEqual(250);
    await Bun.sleep(delay); active--;
    return {code: 0, stderr: "", stdout: argv.includes("--name-status") ? "M\0file.txt\0" : argv.includes("--numstat") ? "2\t1\tfile.txt\0" : "main\n"};
  }});
  mkdirSync(ctx.pacerHome, {recursive: true});
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), 'planner: codex\nproviders:\n  codex: {usage: unmetered}\n  cursor: {usage: unmetered}\n');
  const task = createTask(ctx, {brief: {repo, goal: "Review a settled task", acceptance: "bun test"}, kind: null, requestedExecutor: null, timeoutS: 60});
  updateTask(ctx, task.id, t => { t.state = "done"; t.worktree = repo; });
  return {ctx, task, repo, calls, peak: () => peak};
}

test("task.get runs only summary git in parallel and reuses it across snapshot refetches", async () => {
  const f = fixture(70);
  const first = await callOp(f.ctx, "task.get", {id: f.task.id}) as any;
  expect(first.files).toEqual([{path: "file.txt", status: "modified", added: 2, removed: 1, binary: false}]);
  expect(first.branch).toBe("main");
  expect(f.calls).toHaveLength(3);
  expect(f.peak()).toBe(3);
  expect(f.calls.every(argv => argv.includes("--name-status") || argv.includes("--numstat") || argv.includes("branch"))).toBe(true);
  // Unrelated snapshot/activity changes must not trigger more git.
  appendActivity(f.ctx, {taskId: f.task.id, kind: "verdict", level: "info", text: "Reviewed"});
  const second = await callOp({...f.ctx, now: f.ctx.now + 1}, "task.get", {id: f.task.id}) as any;
  expect(second.files).toEqual(first.files);
  expect(second.timeline.at(-1).text).toBe("Reviewed");
  expect(f.calls).toHaveLength(3);
  writeFileSync(join(f.repo, ".git", "HEAD"), "second-head\n");
  await callOp(f.ctx, "task.get", {id: f.task.id});
  expect(f.calls).toHaveLength(6);
  updateTask(f.ctx, f.task.id, t => { t.baseBranch = "other"; });
  await callOp(f.ctx, "task.get", {id: f.task.id});
  expect(f.calls).toHaveLength(9);
});

test("task.get bounds slow git and returns stored acceptance and explicit unavailable fields", async () => {
  const f = fixture(1200);
  updateTask(f.ctx, f.task.id, t => {t.result = {status: "done", executor: "codex", model: null, backend: "direct", report: "Completed", files: "", acceptance: {cmd: "bun test", passed: true, tail: "all passed"}};});
  const start = performance.now();
  const detail = await callOp(f.ctx, "task.get", {id: f.task.id}) as any;
  expect(performance.now() - start).toBeLessThan(700);
  expect(detail).toMatchObject({state: "done", summary: "Completed", acceptance: {state: "passed"}, files: [], branch: null, derived: {files: "unavailable", branch: "unavailable"}});
  await callOp(f.ctx, "task.get", {id: f.task.id});
  expect(f.calls).toHaveLength(3);
});

test("task.get reads a bounded activity tail instead of parsing historical log pages", async () => {
  const f = fixture(0), dir = join(f.ctx.pacerHome, "state");
  mkdirSync(dir, {recursive: true});
  const historical = JSON.stringify({id: "old", at: 1, kind: "verdict", level: "info", taskId: f.task.id, text: "Old history"}) + "\n";
  const unrelated = JSON.stringify({id: "other", at: 2, kind: "verdict", level: "info", text: "x".repeat(1024)}) + "\n";
  writeFileSync(join(dir, "activity.jsonl"), historical + unrelated.repeat(1024));
  appendActivity(f.ctx, {taskId: f.task.id, kind: "verdict", level: "info", text: "Recent review"});
  const detail = await callOp(f.ctx, "task.get", {id: f.task.id}) as any;
  expect(detail.timeline.some((e: any) => e.text === "Old history")).toBe(false);
  expect(detail.timeline.at(-1).text).toBe("Recent review");
  expect(detail.derived.timeline).toBe("partial");
});


test("task.get batches repository labels with hundreds of stored tasks", async () => {
  const f = fixture(10);
  for (let i = 0; i < 250; i++) createTask(f.ctx, {brief: {repo: f.repo, goal: `Other task ${i}`}, kind: null, requestedExecutor: null, timeoutS: 60});
  const start = performance.now();
  await callOp(f.ctx, "task.get", {id: f.task.id});
  expect(performance.now() - start).toBeLessThan(700);
  expect(f.calls).toHaveLength(3);
});

test("task.get shares concurrent summary reads and invalidates index and symbolic HEAD changes", async () => {
  const f = fixture(10), git = join(f.repo, ".git");
  mkdirSync(join(git, "refs", "heads"), {recursive: true});
  writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(git, "refs", "heads", "main"), "first\n");
  await Promise.all(Array.from({length: 5}, () => callOp(f.ctx, "task.get", {id: f.task.id})));
  expect(f.calls).toHaveLength(3);
  writeFileSync(join(git, "refs", "heads", "main"), "second\n");
  await callOp(f.ctx, "task.get", {id: f.task.id});
  expect(f.calls).toHaveLength(6);
  writeFileSync(join(git, "index"), "changed index");
  await callOp(f.ctx, "task.get", {id: f.task.id});
  expect(f.calls).toHaveLength(9);
});
