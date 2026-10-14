import { expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateStrategy } from "../src/config/strategy";
import { runAttempt, tail } from "../src/exec/direct";
import { createTask, readTask } from "../src/tasks/store";
import { fakeCtx, gitRepo, realRun, tmpDir } from "./helpers";

const s = validateStrategy({ planner: "claude-code", providers: { "claude-code": {}, codex: {}, cursor: {} } }, "/x");

function fakeBin(name: string, script: string): string {
  const dir = tmpDir();
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${script}\n`);
  chmodSync(p, 0o755);
  return dir;
}

async function setup(name: string, script: string, o: { git?: boolean } = {}) {
  const bin = fakeBin(name, script);
  const repo = o.git ? gitRepo() : tmpDir();
  const ctx = fakeCtx({ ...(o.git ? { run: realRun } : {}), env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME } });
  const task = createTask(ctx, { brief: { goal: "Do it", repo }, kind: null, requestedExecutor: null, timeoutS: 30 });
  return { ctx, task, repo };
}

test("codex: report comes from the -o last-message file; attempt recorded", async () => {
  const { ctx, task } = await setup("codex", 'out=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; *) shift;; esac; done; cat >/dev/null; echo "FINAL REPORT" > "$out"; echo noisy');
  let spawned = 0;
  const o = await runAttempt(ctx, s.providers.codex, task, (pid) => { spawned = pid; });
  expect(spawned).toBeGreaterThan(0);
  expect(o.exec.code).toBe(0);
  expect(o.report).toEndWith("FINAL REPORT");
  expect(o.report).toStartWith("ran in place: ");
  expect(o.attempt).toMatchObject({ executor: "codex", model: null, exitCode: 0, timedOut: false, limitHit: false });
  expect(await Bun.file(o.attempt.log).exists()).toBe(true);
});

test("cursor: report is the stdout tail; limit output marks limitHit", async () => {
  const { ctx, task } = await setup("cursor-agent", 'echo "You have hit your usage limit"; exit 1');
  const o = await runAttempt(ctx, s.providers.cursor, task);
  expect(o.report).toContain("usage limit");
  expect(o.attempt.limitHit).toBe(true);
});

test("launcher error becomes a failed attempt instead of throwing", async () => {
  const { ctx, task } = await setup("x", "true");
  const o = await runAttempt(ctx, { ...s.providers.codex, id: "gemini" }, task);
  expect(o.exec.code).toBe(127);
  expect(o.report).toContain('no launcher for provider "gemini"');
  expect(o.attempt.exitCode).toBe(127);
});

test("tail keeps the last n characters", () => {
  expect(tail("abcdef", 3)).toBe("def");
  expect(tail("ab", 3)).toBe("ab");
});

test("executor launch sets its role while preserving the caller environment", async () => {
  const { ctx, task } = await setup("cursor-agent", 'printf "%s:%s" "$PACER_ROLE" "$CUSTOM_VALUE"');
  ctx.env.HOME = ctx.home;
  ctx.env.PACER_ROLE = "planner";
  ctx.env.CUSTOM_VALUE = "kept";
  expect((await runAttempt(ctx, s.providers.cursor, task)).report).toEndWith("executor:kept");
  expect(ctx.env.PACER_ROLE).toBe("planner");
});

 test("explicit current runs in place without the isolation note",async()=>{
 const {ctx,task}=await setup("cursor-agent","echo report");task.placement={requested:"current",reason:"installed dependencies"};
 const out=await runAttempt(ctx,s.providers.cursor,task);expect(out.report).toBe("report");
 expect((await import("../src/tasks/store")).readTask(ctx,task.id)?.placement).toMatchObject({mode:"current",why:"agent: installed dependencies"});
 });

test("explicit new records actual in-place placement and isolation note",async()=>{
 const {ctx,task}=await setup("cursor-agent","echo report");task.placement={requested:"new",reason:"isolation"};
 const out=await runAttempt(ctx,s.providers.cursor,task);expect(out.report).toStartWith("ran in place: ");
 expect((await import("../src/tasks/store")).readTask(ctx,task.id)).toMatchObject({worktree:task.brief.repo,placement:{requested:"new",mode:"current",why:"agent: isolation"}});
});
test("direct fallback remains available when git inspection throws",async()=>{
 const {ctx,task}=await setup("cursor-agent","echo report");ctx.run=async()=>{throw Error("git unavailable");};
 expect((await runAttempt(ctx,s.providers.cursor,task)).exec.code).toBe(0);
});

test("new placement runs in a pacer worktree on branch pacer/<task-id>; the repo itself is untouched", async () => {
  const { ctx, task, repo } = await setup("codex", 'out=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; *) shift;; esac; done; cat >/dev/null; echo hi > made.txt; echo DONE > "$out"', { git: true });
  const o = await runAttempt(ctx, s.providers.codex, task);
  expect(o.exec.code).toBe(0);
  expect(o.worktree).toStartWith(join(ctx.pacerHome, "worktrees") + "/");
  expect(existsSync(join(o.worktree!, "made.txt"))).toBe(true);
  expect(existsSync(join(repo, "made.txt"))).toBe(false);
  expect(o.report).toBe("DONE");
  expect(readTask(ctx, task.id)).toMatchObject({ placement: { mode: "new" }, worktree: o.worktree, run: { attempt: 1, executor: "codex", mode: "new" } });
});

test("non-git repo runs in place with a note", async () => {
  const { ctx, task } = await setup("cursor-agent", "echo done");
  const o = await runAttempt(ctx, s.providers.cursor, task);
  expect(o.report).toStartWith("ran in place: ");
  expect(o.report).toContain("not a git repository");
  expect(readTask(ctx, task.id)?.placement?.mode).toBe("current");
});

test("detached HEAD refuses new placement", async () => {
  const { ctx, task, repo } = await setup("cursor-agent", "echo done", { git: true });
  Bun.spawnSync(["git", "checkout", "-q", "--detach"], { cwd: repo });
  const o = await runAttempt(ctx, s.providers.cursor, task);
  expect(o.exec.code).toBe(1);
  expect(o.report).toContain("detached HEAD");
});

test("live output lands in the run directory while the agent runs; the legacy log is written at the end", async () => {
  const { ctx, task } = await setup("cursor-agent", "echo first; sleep 1; echo second", { git: true });
  const o = await runAttempt(ctx, s.providers.cursor, task);
  const run = readTask(ctx, task.id)!.run!;
  expect(readFileSync(join(run.dir, "stdout"), "utf8")).toBe("first\nsecond\n");
  expect(readFileSync(o.attempt.log, "utf8")).toMatch(/^\$ cursor-agent .*\n--- stdout\nfirst\nsecond\n\n--- stderr\n\n--- exit 0\n$/s);
});
