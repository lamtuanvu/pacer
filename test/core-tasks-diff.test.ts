import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { diff } from "../src/core/tasks";
import { createTask, updateTask } from "../src/tasks/store";
import { fakeCtx, gitRepo, realRun } from "./helpers";

function fixture() {
  const repo = gitRepo(), ctx = fakeCtx({ run: realRun });
  const git = (...args: string[]) => { const r = Bun.spawnSync(["git", "-C", repo, ...args]); expect(r.exitCode).toBe(0); };
  writeFileSync(`${repo}/modified.txt`, "one\n");
  writeFileSync(`${repo}/old.txt`, "rename content\n");
  git("add", "."); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "initial files");
  writeFileSync(`${repo}/modified.txt`, "two\n");
  writeFileSync(`${repo}/added.txt`, "added\n");
  git("mv", "old.txt", "renamed.txt"); git("add", ".");
  const task = createTask(ctx, { brief: { goal: "g", repo }, kind: null, requestedExecutor: null, timeoutS: 60 });
  return { repo, ctx, task, git };
}
test("diff includes per-file statuses and counts and keeps the legacy alias", async () => {
  const { ctx, task } = fixture();
  const result = await diff(ctx, task.id);
  expect(result.files).toEqual([
    { path: "added.txt", status: "added", added: 1, removed: 0, binary: false },
    { path: "modified.txt", status: "modified", added: 1, removed: 1, binary: false },
    { path: "renamed.txt", status: "renamed", added: 0, removed: 0, binary: false },
  ]);
  expect(result.patch).toBe(result.diff);
  const single = await diff(ctx, task.id, { path: "modified.txt" });
  expect(single.patch).toContain("+two");
  expect(single.patch).not.toContain("added.txt");
});
test("remote task diffs the transferred local review worktree", async () => {
  const { ctx, task, repo } = fixture();
  updateTask(ctx, task.id, t => {
    t.state = "done";
    t.run = { host: "devbox", workdir: "/remote/worktree", dir: "/remote/run", attempt: 1, executor: "cursor", startedAt: 1, mode: "new", logFile: "" };
    t.worktree = "devbox:/remote/worktree";
    t.result = { status: "done", worktree: repo, executor: "cursor", model: null, files: "", report: "", backend: "remote" };
  });
  expect((await diff(ctx, task.id)).patch).toContain("+two");
  expect((await diff(ctx, task.id)).worktree).toBe(repo);
});
test("running remote changes return a note without running local git", async () => {
  const ctx = fakeCtx({ run: async () => { throw Error("should not run git"); } });
  const task = createTask(ctx, { brief: { goal: "g", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, task.id, t => { t.state = "running"; t.run = { host: "devbox", workdir: "/remote/worktree", dir: "/remote/run", attempt: 1, executor: "cursor", startedAt: 1, mode: "new", logFile: "" }; });
  expect(await diff(ctx, task.id)).toMatchObject({ files: [], patch: "", diff: "", note: "changes are on devbox until the run ends" });
});
test("diff handles deleted, binary and unusual filenames", async () => {
  const { ctx, task, repo, git } = fixture();
  const path = "tab\tand\nnewline.txt";
  writeFileSync(`${repo}/${path}`, "hello\n");
  writeFileSync(`${repo}/binary`, Buffer.from([0, 1, 2]));
  git("rm", "-f", "modified.txt"); git("add", ".");
  const result = await diff(ctx, task.id);
  expect(result.files).toContainEqual({ path, status: "added", added: 1, removed: 0, binary: false });
  expect(result.files).toContainEqual({ path: "binary", status: "added", added: 0, removed: 0, binary: true });
  expect(result.files).toContainEqual({ path: "modified.txt", status: "deleted", added: 0, removed: 1, binary: false });
});
test("per-file patches retain renames and use the larger cap", async () => {
  const { ctx, task, repo, git } = fixture();
  const renamed = await diff(ctx, task.id, { path: "renamed.txt" });
  expect(renamed.patch).toContain("rename from old.txt");
  writeFileSync(`${repo}/large.txt`, "x".repeat(5 * 1024 * 1024));
  git("add", "large.txt");
  const all = await diff(ctx, task.id);
  expect(all.truncated).toBe(true);
  expect(Buffer.byteLength(all.patch)).toBeLessThanOrEqual(1024 * 1024);
  const single = await diff(ctx, task.id, { path: "large.txt" });
  expect(single.truncated).toBe(true);
  expect(Buffer.byteLength(single.patch)).toBe(4 * 1024 * 1024);
});
test("a failed transfer keeps remote-only changes out of local git", async () => {
  const ctx = fakeCtx({ run: async () => { throw Error("should not run git"); } });
  const task = createTask(ctx, { brief: { goal: "g", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, task.id, t => {
    t.state = "partial";
    t.run = { host: "devbox", workdir: "/remote/worktree", dir: "/remote/run", attempt: 1, executor: "cursor", startedAt: 1, mode: "new", logFile: "" };
    t.result = { status: "partial", worktree: "devbox:/remote/worktree", executor: "cursor", model: null, files: "", report: "transfer failed", backend: "remote" };
  });
  expect(await diff(ctx, task.id)).toMatchObject({ files: [], patch: "", note: "changes are on devbox until the run ends" });
});
