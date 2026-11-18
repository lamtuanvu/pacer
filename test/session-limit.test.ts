import { afterEach, expect, setSystemTime, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { finishRun, progressPoller, runDir } from "../src/exec/direct";
import { validateStrategy } from "../src/config/strategy";
import { startRun } from "../src/supervisor/run";
import { detectSessionLimit, sessionLimitText } from "../src/exec/limits";
import { Recording } from "../src/session/recording";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { fakeCtx, tmpDir } from "./helpers";

test("the session's limit check ignores lines that echo the prompt", () => {
  const dir = tmpDir();
  writeFileSync(join(dir, "prompt.md"), "Handle the provider error.\n  rateLimitReason: prepaid_balance_exhausted\n");
  writeFileSync(join(dir, "stdout"), "Cursor Agent\n  rateLimitReason: prepaid_balance_exhausted\n  Auto\n");
  expect(detectSessionLimit("cursor", sessionLimitText(dir))).toBe(false);
  writeFileSync(join(dir, "stdout"), "Cursor Agent\n  Error: Weekly usage limit reached. It resets in 5 days.\n  Auto\n");
  expect(detectSessionLimit("cursor", sessionLimitText(dir))).toBe(true);
});

test("a quiet interactive Cursor session showing its limit error ends the run as a limit", async () => {
  const ctx = fakeCtx(), dir = tmpDir(), now = Date.now() / 1000;
  const task = createTask(ctx, {brief: {goal: "limit", repo: dir}, kind: null, requestedExecutor: null, timeoutS: 60});
  const run: import("../src/tasks/types").RunRef = {dir, attempt: 1, executor: "cursor", startedAt: now - 60, mode: "current", workdir: dir, logFile: join(dir, "log"), session: "interactive"};
  updateTask(ctx, task.id, t => { t.state = "running"; t.run = run; });
  writeFileSync(join(dir, "stdout"), "Cursor Agent\n  Error: Weekly usage limit reached. It resets in 5 days.\n");
  const state = (lastOutputAt: number) => ({pid: null, startedAt: now - 60, exit: null, alive: true, stdoutBytes: 70, stderrBytes: 0, lastOutputAt, interactive: true});
  // Still printing: wait for the screen to settle before deciding.
  expect(await progressPoller(ctx, task, run)(state(now))).toBe("continue");
  expect(await progressPoller(ctx, task, run)(state(now - 30))).toBe("limit");
  // A conversation lane belongs to the user and is never ended for a limit.
  expect(await progressPoller(ctx, task, {...run, interactionMode: "conversation"})(state(now - 30))).toBe("continue");
});

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name));
const CLEARED = Buffer.from("\x1b[2J\x1b[H  Thinking about the change\r\n");

/** An OpenCode run whose PTY recording plays the given fixture; the clock is pinned to `at`. */
async function opencodeRun(name: string, at: number, extra: Partial<import("../src/tasks/types").RunRef> = {}) {
  setSystemTime(new Date(at * 1000));
  const ctx = fakeCtx(), dir = tmpDir();
  const task = createTask(ctx, {brief: {goal: "retry", repo: dir}, kind: null, requestedExecutor: null, timeoutS: 7200});
  const run: import("../src/tasks/types").RunRef = {dir, attempt: 1, executor: "opencode#tse", startedAt: at - 60, mode: "current", workdir: dir, logFile: join(dir, "log"), session: "interactive", ...extra};
  updateTask(ctx, task.id, t => { t.state = "running"; t.run = run; });
  const recording = new Recording(dir);
  const show = async (data: Buffer, when: number) => { setSystemTime(new Date(when * 1000)); await recording.output(data); };
  await show(fixture(name), at);
  const state = (when: number) => ({pid: null, startedAt: at - 60, exit: null, alive: true, stdoutBytes: statSync(join(dir, "stdout")).size, stderrBytes: 0, lastOutputAt: when, interactive: true});
  return {ctx, task, run, dir, recording, show, state};
}

afterEach(() => { setSystemTime(); });

test("an animating OpenCode rate-limit banner ends the run as a limit", async () => {
  const t = 1_800_000_000, r = await opencodeRun("opencode-retry-ratelimit.ansi", t);
  try {
    // Still printing (lastOutputAt is now): the banner decides without waiting for the screen to settle.
    expect(await progressPoller(r.ctx, r.task, r.run)(r.state(t))).toBe("limit");
  } finally { await r.recording.close(); }
});

test("a transient banner ends the run as provider after the window", async () => {
  const t = 1_800_000_000, r = await opencodeRun("opencode-retry-524.ansi", t);
  try {
    expect(await progressPoller(r.ctx, r.task, r.run)(r.state(t))).toBe("continue");
    expect(r.run.retryBanner).toEqual({since: t, reason: expect.stringContaining("HTTP 524")});
    // The window is persisted on the task's run, so a resumed poller keeps it.
    const persisted = readTask(r.ctx, r.task.id)!.run!;
    expect(persisted.retryBanner?.since).toBe(t);
    await r.show(fixture("opencode-retry-524.ansi"), t + 10 * 60 + 1);
    expect(await progressPoller(r.ctx, r.task, persisted)(r.state(t + 10 * 60 + 1))).toBe("provider");
  } finally { await r.recording.close(); }
});

test("a banner that clears and returns keeps its window", async () => {
  const t = 1_800_000_000, r = await opencodeRun("opencode-retry-524.ansi", t);
  try {
    const poll = progressPoller(r.ctx, r.task, r.run);
    expect(await poll(r.state(t))).toBe("continue");
    await r.show(CLEARED, t + 60);
    expect(await poll(r.state(t + 60))).toBe("continue");
    expect(r.run.retryBanner?.since).toBe(t);
    await r.show(fixture("opencode-retry-524.ansi"), t + 601);
    expect(await poll(r.state(t + 601))).toBe("provider");
  } finally { await r.recording.close(); }
});

test("progress clears the window", async () => {
  const t = 1_800_000_000, r = await opencodeRun("opencode-retry-524.ansi", t);
  let status = "";
  r.ctx.run = async () => ({code: 0, stdout: status, stderr: ""});
  try {
    const poll = progressPoller(r.ctx, r.task, r.run);
    expect(await poll(r.state(t))).toBe("continue");
    status = "?? a.ts\0";
    await r.show(CLEARED, t + 60);
    expect(await poll(r.state(t + 60))).toBe("continue");
    expect(r.run.retryBanner).toBeUndefined();
    expect(readTask(r.ctx, r.task.id)!.run!.retryBanner).toBeUndefined();
    await r.show(fixture("opencode-retry-524.ansi"), t + 601);
    expect(await poll(r.state(t + 601))).toBe("continue");
    expect(r.run.retryBanner?.since).toBe(t + 601);
  } finally { await r.recording.close(); }
});

test("a resumed poller keeps the window over existing edits", async () => {
  const t = 1_800_000_000, since = t - 10 * 60 - 1;
  const r = await opencodeRun("opencode-retry-524.ansi", t, {retryBanner: {since, reason: "Provider request failed with HTTP 524"}});
  updateTask(r.ctx, r.task.id, x => { x.run!.retryBanner = {since, reason: "Provider request failed with HTTP 524"}; });
  // The worktree already has edits when the poller starts; they are not new progress.
  r.ctx.run = async () => ({code: 0, stdout: "?? a.ts\0", stderr: ""});
  try {
    expect(await progressPoller(r.ctx, r.task, readTask(r.ctx, r.task.id)!.run!)(r.state(t))).toBe("provider");
  } finally { await r.recording.close(); }
});

test("conversation mode is not ended by a banner", async () => {
  const t = 1_800_000_000;
  for (const name of ["opencode-retry-ratelimit.ansi", "opencode-retry-524.ansi"]) {
    const r = await opencodeRun(name, t, {interactionMode: "conversation", retryBanner: {since: t - 3600, reason: "HTTP 524"}});
    try {
      expect(await progressPoller(r.ctx, r.task, r.run)(r.state(t))).toBe("continue");
    } finally { await r.recording.close(); }
  }
});

test("a provider end fails the attempt as broken, not as a limit", async () => {
  const ctx = fakeCtx({now: Date.now() / 1000}), repo = tmpDir(), startedAt = Date.now() / 1000;
  const cursor = validateStrategy({planner: "claude-code", providers: {"claude-code": {}, cursor: {}}}, "/x").providers.cursor;
  const t = createTask(ctx, {brief: {goal: "g", repo}, kind: null, requestedExecutor: "cursor", timeoutS: 60});
  const dir = runDir(ctx, t.id, 1);
  startRun({dir, argv: ["sh", "-c", "sleep 30"], cwd: repo, env: {PATH: process.env.PATH}});
  const run: import("../src/tasks/types").RunRef = {dir, attempt: 1, executor: "cursor", startedAt, mode: "current", workdir: repo, logFile: join(ctx.pacerHome, "tasks", `${t.id}.log`),
    retryBanner: {since: startedAt - 11 * 60, reason: "Provider request failed with HTTP 524"}};
  const task = updateTask(ctx, t.id, x => { x.state = "running"; x.attemptStartedAt = startedAt; x.run = run; });
  const out = await finishRun(ctx, cursor, task, run, "", async () => "provider");
  expect(out.attempt.limitHit).toBe(false);
  expect(out.attempt.brokenReason).toBe("provider retrying: Provider request failed with HTTP 524");
  expect(out.exec.code).not.toBe(0);
  expect(out.exec.stderr).toContain("pacer: cursor kept retrying a provider error for 11 min: Provider request failed with HTTP 524");
});

test("the poller marks a git progress signal only when it read the worktree", async () => {
  const now = Date.now() / 1000;
  const poll = async (o: {git: boolean; host?: string}) => {
    const ctx = fakeCtx(), dir = tmpDir();
    if (o.git) ctx.run = async () => ({code: 0, stdout: "", stderr: ""});
    const task = createTask(ctx, {brief: {goal: "g", repo: dir}, kind: null, requestedExecutor: null, timeoutS: 600});
    const run: import("../src/tasks/types").RunRef = {dir, attempt: 1, executor: "codex", startedAt: now - 120, mode: "current", workdir: dir, logFile: join(dir, "log"), ...(o.host ? {host: o.host} : {})};
    updateTask(ctx, task.id, t => { t.state = "running"; t.run = run; });
    await progressPoller(ctx, task, run)({pid: null, startedAt: now - 120, exit: null, alive: true, stdoutBytes: 10, stderrBytes: 0, lastOutputAt: now});
    return readTask(ctx, task.id)!.progress!;
  };
  expect((await poll({git: true})).gitObserved).toBe(true);
  expect((await poll({git: false})).gitObserved).toBeUndefined();
  expect((await poll({git: true, host: "devbox"})).gitObserved).toBeUndefined();
});

test("a human typing in the run's terminal is recorded on its progress", async () => {
  const ctx = fakeCtx(), dir = tmpDir(), now = Date.now() / 1000;
  const task = createTask(ctx, {brief: {goal: "g", repo: dir}, kind: null, requestedExecutor: null, timeoutS: 600});
  const run: import("../src/tasks/types").RunRef = {dir, attempt: 1, executor: "codex", startedAt: now - 120, mode: "current", workdir: dir, logFile: join(dir, "log"), session: "interactive"};
  updateTask(ctx, task.id, t => { t.state = "running"; t.run = run; });
  const state = (controller: string | null) => ({pid: null, startedAt: now - 120, exit: null, alive: true, stdoutBytes: 10, stderrBytes: 0, lastOutputAt: now, interactive: true, controller});
  const poll = progressPoller(ctx, task, run);
  await poll(state("client-1"));
  expect(readTask(ctx, task.id)!.progress).toMatchObject({phase: "working", controlled: true});
  setSystemTime(new Date((now + 11) * 1000));
  await poll(state(null));
  expect(readTask(ctx, task.id)!.progress!.controlled).toBeUndefined();
});
