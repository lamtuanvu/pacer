import { expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { progressPoller } from "../src/exec/direct";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { RunRef } from "../src/tasks/types";
import { fakeCtx, gitRepo, realRun } from "./helpers";
import { gitFingerprint, idleSeconds, nextProgress } from "../src/supervisor/progress";

const base = { startedAt: 1000, logBytes: 0, lastOutputAt: null, files: 0, commits: 0 };

test("starting until the first output or 60 s", () => {
  expect(nextProgress({ ...base, now: 1030 }, 600).phase).toBe("starting");
  expect(nextProgress({ ...base, now: 1061 }, 600).phase).toBe("working");
  expect(nextProgress({ ...base, now: 1010, logBytes: 5, lastOutputAt: 1009 }, 600).phase).toBe("working");
});

test("a change in files or commits moves lastChangeAt", () => {
  const p1 = nextProgress({ ...base, now: 1100, files: 1 }, 600);
  expect(p1.lastChangeAt).toBe(1100);
  const p2 = nextProgress({ ...base, now: 1200, files: 1, prev: p1 }, 600);
  expect(p2.lastChangeAt).toBe(1100);
  const p3 = nextProgress({ ...base, now: 1300, files: 1, commits: 1, prev: p2 }, 600);
  expect(p3.lastChangeAt).toBe(1300);
});

test("idle after idleAfterS without output or changes; idleSeconds counts from the latest activity", () => {
  const p = nextProgress({ ...base, now: 2000, logBytes: 10, lastOutputAt: 1300 }, 600);
  expect(p.phase).toBe("idle");
  expect(idleSeconds(p, 1000, 2000)).toBe(700);
  expect(nextProgress({ ...base, now: 1800, logBytes: 10, lastOutputAt: 1300 }, 600).phase).toBe("working");
});

test("host defaults to local", () => {
  expect(nextProgress({ ...base, now: 1001 }, 600).host).toBe("local");
});

test("git fingerprints hash content up to 4 MiB and retain the total byte length", () => {
  expect(gitFingerprint(" M file\0", "first")).not.toBe(gitFingerprint(" M file\0", "other"));
  expect(gitFingerprint(" M file\0", "same")).not.toBe(gitFingerprint(" M name\0", "same"));
  const prefix = "x".repeat(4 * 1024 * 1024);
  expect(gitFingerprint("", prefix + "a")).toBe(gitFingerprint("", prefix + "b"));
  expect(gitFingerprint("", prefix + "a")).not.toBe(gitFingerprint("", prefix + "aa"));
});

test("editing an already-modified file resets idle without output or count changes", async () => {
  const repo = gitRepo();
  const file = join(repo, "tracked.txt");
  writeFileSync(file, "original\n");
  await realRun(["git", "-C", repo, "add", "."], 10000);
  await realRun(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "tracked file"], 10000);
  writeFileSync(file, "first edit\n");
  const ctx = fakeCtx({ run: realRun });
  const task = createTask(ctx, { brief: { goal: "Edit", repo }, kind: null, requestedExecutor: null, timeoutS: 3600 });
  const run: RunRef = { dir: repo, attempt: 1, executor: "cursor", startedAt: 1000, mode: "current", workdir: repo, logFile: join(repo, "unused.log") };
  const poll = progressPoller(ctx, task, run);
  const state = { pid: null, startedAt: 1000, exit: null, alive: true, stdoutBytes: 0, stderrBytes: 0, lastOutputAt: null };
  const now = spyOn(Date, "now");
  try {
    now.mockReturnValue(1000_000);
    expect(await poll(state)).toBe("continue");
    expect(readTask(ctx, task.id)?.progress).toMatchObject({ files: 1, commits: 0, lastChangeAt: 1000 });
    writeFileSync(file, "second edit\n");
    now.mockReturnValue(1011_000);
    expect(await poll(state)).toBe("continue");
    expect(readTask(ctx, task.id)?.progress?.lastChangeAt).toBe(1000);
    now.mockReturnValue(2801_000);
    expect(await poll(state)).toBe("continue");
    expect(readTask(ctx, task.id)?.progress).toMatchObject({ phase: "working", files: 1, commits: 0, logBytes: 0, lastChangeAt: 2801 });
    now.mockReturnValue(2832_000);
    expect(await poll(state)).toBe("continue");
    expect(readTask(ctx, task.id)?.progress?.lastChangeAt).toBe(2801);
  } finally { now.mockRestore(); }
});

test("remote progress never polls local git", async () => {
  let gitCalls = 0;
  const ctx = fakeCtx({ run: async () => { gitCalls++; return { code: 0, stdout: "", stderr: "" }; } });
  const task = createTask(ctx, { brief: { goal: "Remote", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 3600 });
  const run: RunRef = { dir: ctx.home, attempt: 1, executor: "codex", startedAt: Date.now() / 1000, mode: "new", workdir: "/remote", logFile: "unused", host: "remote" };
  await progressPoller(ctx, task, run)({ pid: null, startedAt: run.startedAt, exit: null, alive: true, stdoutBytes: 0, stderrBytes: 0, lastOutputAt: null });
  expect(gitCalls).toBe(0);
});

test("interactive needs-input alerts once and pauses idle failure until running resumes", async () => {
  const { readLatest } = await import("../src/link/store");
  const ctx = fakeCtx();
  const task = createTask(ctx, {brief: {goal: "Interactive", repo: ctx.home}, kind: null, requestedExecutor: null, timeoutS: 10000});
  const run: RunRef = {dir: ctx.home, attempt: 1, executor: "codex", startedAt: 1, mode: "current", workdir: ctx.home, logFile: "unused"};
  const poll = progressPoller(ctx, task, run);
  const state = {pid: null, startedAt: 1, exit: null, alive: true, stdoutBytes: 0, stderrBytes: 0, lastOutputAt: null, interactive: true, report: {status: "needs-input" as const, summary: "Approve this", at: Date.now()/1000}};
  expect(await poll(state)).toBe("continue");
  expect(await poll(state)).toBe("continue");
  expect(readTask(ctx, task.id)?.progress?.phase).toBe("needs-input");
  expect(readLatest(ctx).alerts.filter(a => a.key.startsWith(`needs-input-${task.id}-`))).toHaveLength(1);
  expect(await poll({...state, report: {...state.report, status: "running"}})).toBe("continue");
  expect(readTask(ctx, task.id)?.progress?.phase).toBe("working");
});

test("interactive terminal output keeps a long tool call alive without completing it", async () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, {brief: {goal: "Spinner", repo: ctx.home}, kind: null, requestedExecutor: null, timeoutS: 10000});
  const run: RunRef = {dir: ctx.home, attempt: 1, executor: "codex", startedAt: 1, mode: "current", workdir: ctx.home, logFile: "unused"};
  const state = {pid: null, startedAt: 1, exit: null, alive: true, stdoutBytes: 100, stderrBytes: 0, lastOutputAt: Date.now()/1000, interactive: true, report: {status: "running" as const, summary: "Working", at: 1}};
  expect(await progressPoller(ctx, task, run)(state)).toBe("continue");
});

test("a controller pauses idle failure and release starts a fresh idle period", async () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, {brief: {goal: "Control", repo: ctx.home}, kind: null, requestedExecutor: null, timeoutS: 10000});
  const run: RunRef = {dir: ctx.home, attempt: 1, executor: "codex", startedAt: 1, mode: "current", workdir: ctx.home, logFile: "unused"};
  const poll = progressPoller(ctx, task, run);
  const state = {pid: null, startedAt: 1, exit: null, alive: true, stdoutBytes: 0, stderrBytes: 0, lastOutputAt: null, interactive: true, controller: "human"};
  expect(await poll(state)).toBe("continue");
  expect(await poll({...state, controller: null})).toBe("continue");
});

test("turn-ended waits 120s of no activity and no controller before alerting", async () => {
  const {readLatest} = await import("../src/link/store");
  const ctx = fakeCtx();
  const task = createTask(ctx, {brief: {goal: "Turn", repo: ctx.home}, kind: null, requestedExecutor: null, timeoutS: 10000});
  const run: RunRef = {dir: ctx.home, attempt: 1, executor: "codex", startedAt: 1000, mode: "current", workdir: ctx.home, logFile: "unused"};
  const poll = progressPoller(ctx, task, run), clock = spyOn(Date, "now");
  const state = {pid: null, startedAt: 1000, exit: null, alive: true, stdoutBytes: 100, stderrBytes: 0, lastOutputAt: 1000, interactive: true, report: {status: "turn-ended" as const, summary: "Turn ended", at: 1000}};
  try {
    clock.mockReturnValue(1119_000);
    expect(await poll(state)).toBe("continue");
    expect(readLatest(ctx).alerts).toHaveLength(0);
    clock.mockReturnValue(1120_000);
    expect(await poll({...state, controller: "human"})).toBe("continue");
    expect(readLatest(ctx).alerts).toHaveLength(0);
    clock.mockReturnValue(1200_000);
    expect(await poll(state)).toBe("continue");
    expect(readLatest(ctx).alerts).toHaveLength(0);
    clock.mockReturnValue(1319_000);
    expect(await poll(state)).toBe("continue");
    expect(readLatest(ctx).alerts).toHaveLength(0);
    clock.mockReturnValue(1320_000);
    expect(await poll(state)).toBe("continue");
    expect(readTask(ctx, task.id)?.progress?.phase).toBe("needs-input");
    expect(readLatest(ctx).alerts).toHaveLength(1);
  } finally {clock.mockRestore();}
});

test("headless controllers do not suppress idle failure", async () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, {brief: {goal: "Headless", repo: ctx.home}, kind: null, requestedExecutor: null, timeoutS: 10000});
  const run: RunRef = {dir: ctx.home, attempt: 1, executor: "cursor", startedAt: 1, mode: "current", workdir: ctx.home, logFile: "unused"};
  expect(await progressPoller(ctx, task, run)({pid: null, startedAt: 1, exit: null, alive: true, stdoutBytes: 0, stderrBytes: 0, lastOutputAt: null, controller: "human"})).toBe("idle");
});

test("separate input waits get distinct alerts and resuming clears each warning", async () => {
  const {readLatest} = await import("../src/link/store");
  const ctx = fakeCtx();
  const task = createTask(ctx, {brief: {goal: "Wait twice", repo: ctx.home}, kind: null, requestedExecutor: null, timeoutS: 10000});
  const run: RunRef = {dir: ctx.home, attempt: 1, executor: "cursor", startedAt: 1, mode: "current", workdir: ctx.home, logFile: "unused"};
  const poll = progressPoller(ctx, task, run);
  const state = {pid: null, startedAt: 1, exit: null, alive: true, stdoutBytes: 0, stderrBytes: 0, lastOutputAt: null, interactive: true};
  for (let n = 0; n < 2; n++) {
    await poll({...state, report: {status: "needs-input", summary: "Question", at: 1+n}});
    expect(readLatest(ctx).alerts.filter(a => a.level === "warn")).toHaveLength(1);
    await poll({...state, report: {status: "running", summary: "Resumed", at: 3+n}});
    expect(readLatest(ctx).alerts.filter(a => a.level === "warn")).toHaveLength(0);
  }
  expect(readLatest(ctx).alerts).toHaveLength(2);
  expect(readLatest(ctx).alerts.every(a => a.level === "info" && a.title.includes("resumed"))).toBe(true);
});

test("terminal activity after Stop delays the input alert without completing the task", async () => {
  const {readLatest} = await import("../src/link/store");
  const ctx = fakeCtx();
  const task = createTask(ctx, {brief: {goal: "Still active", repo: ctx.home}, kind: null, requestedExecutor: null, timeoutS: 10000});
  const run: RunRef = {dir: ctx.home, attempt: 1, executor: "codex", startedAt: 1000, mode: "current", workdir: ctx.home, logFile: "unused"};
  const poll = progressPoller(ctx, task, run), clock = spyOn(Date, "now");
  const state = {pid: null, startedAt: 1000, exit: null, alive: true, stdoutBytes: 100, stderrBytes: 0, lastOutputAt: 1199, interactive: true, report: {status: "turn-ended" as const, summary: "Turn ended", at: 1000}};
  try {
    clock.mockReturnValue(1200_000);
    expect(await poll(state)).toBe("continue");
    expect(readLatest(ctx).alerts).toHaveLength(0);
    clock.mockReturnValue(1319_000);
    expect(await poll(state)).toBe("continue");
    expect(readTask(ctx, task.id)?.progress?.phase).toBe("needs-input");
  } finally {clock.mockRestore();}
});

const commit = (repo: string, message: string) => realRun(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", message], 10000);
async function committedRun(mode: "current" | "new") {
  const repo = gitRepo();
  const head = async () => (await realRun(["git", "-C", repo, "rev-parse", "HEAD"], 10000)).stdout.trim();
  const ctx = fakeCtx({ run: realRun });
  const start = await head();
  const task = createTask(ctx, { brief: { goal: "Commit", repo }, kind: null, requestedExecutor: null, timeoutS: 3600, ...(mode === "new" ? { baseBranch: "main", baseSha: start } : {}) });
  if (mode === "current") updateTask(ctx, task.id, t => { t.startSha = start; });
  const run: RunRef = { dir: repo, attempt: 1, executor: "cursor", startedAt: 1000, mode, workdir: repo, logFile: join(repo, "unused.log") };
  return { repo, ctx, task, run };
}
const idleState = { pid: null, startedAt: 1000, exit: null, alive: true, stdoutBytes: 0, stderrBytes: 0, lastOutputAt: null };

for (const mode of ["current", "new"] as const) test(`${mode} placement counts committed files and commits against the start commit`, async () => {
  const { repo, ctx, task, run } = await committedRun(mode);
  writeFileSync(join(repo, "one.txt"), "1\n"); writeFileSync(join(repo, "two.txt"), "2\n");
  await realRun(["git", "-C", repo, "add", "."], 10000);
  await commit(repo, "work");
  writeFileSync(join(repo, "untracked.txt"), "u\n");
  const now = spyOn(Date, "now");
  try {
    now.mockReturnValue(1000_000);
    await progressPoller(ctx, task, run)(idleState);
    expect(readTask(ctx, task.id)?.progress).toMatchObject({ files: 3, commits: 1, lastChangeAt: 1000 });
  } finally { now.mockRestore(); }
});

test("a commit from a clean tree to a clean tree counts as change", async () => {
  const { repo, ctx, task, run } = await committedRun("current");
  writeFileSync(join(repo, "a.txt"), "a\n");
  await realRun(["git", "-C", repo, "add", "."], 10000);
  await commit(repo, "first");
  const poll = progressPoller(ctx, task, run);
  const now = spyOn(Date, "now");
  try {
    now.mockReturnValue(1000_000);
    await poll(idleState);
    expect(readTask(ctx, task.id)?.progress).toMatchObject({ files: 1, commits: 1, lastChangeAt: 1000 });
    writeFileSync(join(repo, "a.txt"), "b\n");
    await realRun(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qa", "--amend", "-m", "amended"], 10000);
    now.mockReturnValue(1031_000);
    await poll(idleState);
    expect(readTask(ctx, task.id)?.progress).toMatchObject({ files: 1, commits: 1, lastChangeAt: 1031 });
  } finally { now.mockRestore(); }
});

test("git fingerprints change when HEAD moves", () => {
  expect(gitFingerprint("", "", "a")).not.toBe(gitFingerprint("", "", "b"));
test("a delegated interactive run ends once the executor asked a question and its turn ended", async () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, {brief: {goal: "Ask", repo: ctx.home}, kind: null, requestedExecutor: null, timeoutS: 10000});
  const run: RunRef = {dir: ctx.home, attempt: 1, executor: "codex", startedAt: 1000, mode: "current", workdir: ctx.home, logFile: "unused"};
  const now = Date.now() / 1000;
  const state = {pid: null, startedAt: 1000, exit: null, alive: true, stdoutBytes: 100, stderrBytes: 0, lastOutputAt: now, interactive: true, report: {status: "turn-ended" as const, summary: "Turn ended", at: now}};
  const poll = progressPoller(ctx, task, run);
  expect(await poll(state)).toBe("continue");
  const {updateTask} = await import("../src/tasks/store");
  updateTask(ctx, task.id, t => { t.question = {text: "Which table?", at: now - 1}; });
  expect(await poll(state)).toBe("asked");
  // Someone attached and drives the session: it stays up.
  expect(await poll({...state, controller: "human"})).toBe("continue");
  // A conversation is never ended for a question.
  expect(await progressPoller(ctx, task, {...run, interactionMode: "conversation"})(state)).toBe("continue");
  // A question answered earlier does not end the run.
  updateTask(ctx, task.id, t => { t.question = {text: "Which table?", at: now - 1, answer: "users"}; });
  expect(await progressPoller(ctx, task, run)(state)).toBe("continue");
});
