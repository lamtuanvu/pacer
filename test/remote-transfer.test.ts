import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transferBack } from "../src/remote/transfer";
import { createTask } from "../src/tasks/store";
import type { RunRef } from "../src/tasks/types";
import type { HostCfg } from "../src/config/hosts";
import { fakeCtx, fakeSshEnv, realRun, tmpDir } from "./helpers";

async function setup() {
  const root = tmpDir(), hostHome = join(root, "host"), repo = join(root, "local"), origin = join(root, "origin.git"), checkout = join(hostHome, "src/r");
  mkdirSync(hostHome, { recursive: true });
  const git = async (...args: string[]) => {
    const r = await realRun(["git", ...args], 60000);
    if (r.code) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  await git("init", "--bare", "-q", "-b", "main", origin);
  await git("clone", "-q", origin, repo);
  await git("-C", repo, "config", "user.name", "Test");
  await git("-C", repo, "config", "user.email", "test@example.invalid");
  await git("-C", repo, "commit", "-q", "--allow-empty", "-m", "base");
  await git("-C", repo, "push", "-q", "origin", "main");
  await git("clone", "-q", origin, checkout);
  await git("-C", checkout, "config", "user.name", "Test");
  await git("-C", checkout, "config", "user.email", "test@example.invalid");
  const env = { ...process.env, ...fakeSshEnv(hostHome, join(root, "ssh.log")) };
  const ctx = fakeCtx({ env, run: (argv, ms, o) => realRun(argv, ms, { ...o, env }) });
  const task = createTask(ctx, { brief: { goal: "transfer", repo }, kind: "feature", requestedExecutor: null, timeoutS: 30 });
  const baseSha = await git("-C", repo, "rev-parse", "HEAD"), branch = `pacer/${task.id}`;
  await git("-C", checkout, "checkout", "-q", "-b", branch);
  const host: HostCfg = { alias: "box", ssh: "box-ssh", repos: {}, accounts: {}, maxTasks: 2 };
  const run: RunRef = { dir: root, attempt: 1, executor: "codex@box", startedAt: 0, mode: "new", workdir: checkout, logFile: join(root, "log"), host: "box", remoteWorktree: checkout, baseSha };
  const commit = (...args: string[]) => git("-C", checkout, "commit", "-q", "--allow-empty", ...args);
  return { ctx, task, host, run, git, repo, checkout, branch, commit };
}

test("pre-flight refusals leave local refs untouched", async () => {
  for (const kind of ["author", "committer", "signoff", "non-descendant", "empty", "dirty", "501"]) {
    const f = await setup();
    let reason: string;
    if (kind === "author") {
      await f.commit("--author", "Foreign <foreign@example.invalid>", "-m", "foreign");
      reason = "foreign identity foreign@example.invalid; run pacer host setup box";
    } else if (kind === "committer") {
      await f.git("-C", f.checkout, "config", "user.email", "foreign@example.invalid");
      await f.commit("--author", "Test <test@example.invalid>", "-m", "foreign");
      reason = "foreign identity foreign@example.invalid; run pacer host setup box";
    } else if (kind === "signoff") {
      await f.commit("-m", "result\n\nSigned-off-by: Foreign <foreign@example.invalid>");
      reason = "foreign identity foreign@example.invalid; run pacer host setup box";
    } else if (kind === "non-descendant") {
      await f.git("-C", f.checkout, "checkout", "-q", "--orphan", "other");
      await f.commit("-m", "other");
      await f.git("-C", f.checkout, "branch", "-f", f.branch, "HEAD");
      await f.git("-C", f.checkout, "checkout", "-q", f.branch);
      reason = "not a descendant of the base";
    } else if (kind === "empty") reason = "no commits";
    else if (kind === "dirty") {
      await f.commit("-m", "result");
      writeFileSync(join(f.checkout, "dirty.txt"), "dirty");
      reason = "uncommitted changes on the host: dirty.txt";
    } else {
      for (let i = 0; i < 501; i++) await f.commit("-m", `commit ${i}`);
      reason = "501 commits exceed 500";
    }
    expect(await transferBack(f.ctx, f.task, f.host, f.run)).toEqual({ ok: false, reason });
    expect(await f.git("-C", f.repo, "for-each-ref", "refs/heads/pacer")).toBe("");
  }
}, 120000);

test("an existing local task branch is never overwritten", async () => {
  const f = await setup();
  await f.commit("-m", "result");
  await f.git("-C", f.repo, "branch", f.branch);
  const before = await f.git("-C", f.repo, "rev-parse", f.branch);
  expect(await transferBack(f.ctx, f.task, f.host, f.run)).toEqual({ ok: false, reason: `local branch ${f.branch} exists; not overwritten` });
  expect(await f.git("-C", f.repo, "rev-parse", f.branch)).toBe(before);
});

test("a clean transfer fetches only pacer/<id> and opens a review worktree", async () => {
  const f = await setup();
  writeFileSync(join(f.checkout, "binary"), Buffer.from([0, 255, 254, 128, 10]));
  await f.git("-C", f.checkout, "add", "binary");
  await f.commit("-m", "result\n\nSigned-off-by: Test <test@example.invalid>");
  await f.git("-C", f.checkout, "tag", "do-not-fetch");
  const before = (await f.git("-C", f.repo, "for-each-ref", "--format=%(refname)")).split("\n");
  const result = await transferBack(f.ctx, f.task, f.host, f.run);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  expect(result.branch).toBe(f.branch);
  expect(result.commits).toBe(1);
  const after = (await f.git("-C", f.repo, "for-each-ref", "--format=%(refname)")).split("\n");
  expect(after.filter(r => !before.includes(r))).toEqual([`refs/heads/${f.branch}`]);
  expect(await f.git("-C", result.reviewWorktree, "rev-parse", "HEAD")).toBe(await f.git("-C", f.checkout, "rev-parse", "HEAD"));
  expect(Buffer.from(await Bun.file(join(result.reviewWorktree, "binary")).arrayBuffer())).toEqual(Buffer.from([0, 255, 254, 128, 10]));
  expect(existsSync(join(f.ctx.pacerHome, "tasks", `${f.task.id}.bundle`))).toBe(false);
});
