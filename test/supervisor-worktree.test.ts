import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitInfo } from "../src/core/git";
import { createTaskWorktree, removeTaskWorktree, taskWorktreePath, worktreeDirty } from "../src/supervisor/worktree";
import { fakeCtx, gitRepo, realRun } from "./helpers";

const ID = "t-20261014-120000-abcd";

async function info(repo: string) { const i = await gitInfo(realRun, repo); if ("error" in i) throw new Error(i.error); return i; }

test("creates pacer/<task-id> under pacerHome/worktrees from the base", async () => {
  const ctx = fakeCtx({ run: realRun }), repo = gitRepo();
  const w = await createTaskWorktree(ctx, await info(repo), ID, "main");
  if ("error" in w) throw new Error(w.error);
  expect(w.branch).toBe(`pacer/${ID}`);
  expect(w.path).toBe(taskWorktreePath(ctx, (await info(repo)).top, ID));
  expect(w.path.startsWith(join(ctx.pacerHome, "worktrees") + "/")).toBe(true);
  expect(w.workdir).toBe(w.path);
  expect(Bun.spawnSync(["git", "-C", w.path, "rev-parse", "--abbrev-ref", "HEAD"]).stdout.toString().trim()).toBe(`pacer/${ID}`);
});

test("a brief inside a subdirectory works in the same subdirectory of the worktree", async () => {
  const ctx = fakeCtx({ run: realRun }), repo = gitRepo();
  mkdirSync(join(repo, "pkg"));
  writeFileSync(join(repo, "pkg", "a.txt"), "a");
  Bun.spawnSync(["sh", "-c", "git add -A && git -c user.email=t@t -c user.name=t commit -q -m pkg"], { cwd: repo });
  const w = await createTaskWorktree(ctx, await info(join(repo, "pkg")), ID, "main");
  if ("error" in w) throw new Error(w.error);
  expect(w.workdir).toBe(join(w.path, "pkg"));
  expect(existsSync(join(w.workdir, "a.txt"))).toBe(true);
});

test("an existing branch of the same name is an error, not a reuse", async () => {
  const ctx = fakeCtx({ run: realRun }), repo = gitRepo();
  Bun.spawnSync(["git", "branch", `pacer/${ID}`], { cwd: repo });
  const w = await createTaskWorktree(ctx, await info(repo), ID, "main");
  expect("error" in w && w.error).toMatch(/git worktree add failed/);
});

test("dirty check and removal; removal refuses a dirty worktree without force and keeps the branch", async () => {
  const ctx = fakeCtx({ run: realRun }), repo = gitRepo(), i = await info(repo);
  const w = await createTaskWorktree(ctx, i, ID, "main");
  if ("error" in w) throw new Error(w.error);
  expect(await worktreeDirty(ctx, w.path)).toBe(false);
  writeFileSync(join(w.path, "x.txt"), "x");
  expect(await worktreeDirty(ctx, w.path)).toBe(true);
  expect("error" in await removeTaskWorktree(ctx, i.top, w.path)).toBe(true);
  expect(await removeTaskWorktree(ctx, i.top, w.path, { force: true })).toEqual({ ok: true });
  expect(existsSync(w.path)).toBe(false);
  expect(Bun.spawnSync(["git", "-C", repo, "rev-parse", "--verify", `pacer/${ID}`]).exitCode).toBe(0);
});
