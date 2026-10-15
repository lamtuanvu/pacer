import { expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { progressPoller } from "../src/exec/direct";
import { createTask, readTask } from "../src/tasks/store";
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
