import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { progressPoller } from "../src/exec/direct";
import { detectSessionLimit, sessionLimitText } from "../src/exec/limits";
import { createTask, updateTask } from "../src/tasks/store";
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
