import { expect, test } from "bun:test";
import { supervise } from "../src/supervisor/supervise";
import type { RunState } from "../src/supervisor/run";
import { tmpDir } from "./helpers";
import { agentHook, readReport, writeReport } from "../src/session/reports";
import { writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { localRunIO, startRun, stopRun } from "../src/supervisor/run";
import { fakeCtx } from "./helpers";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { progressPoller } from "../src/exec/direct";
import { taskData } from "../src/link/pump";
import { slotUse } from "../src/engine/slots";
import { eligibleForRetention } from "../src/tasks/retention";
import { runAttempt } from "../src/exec/direct";
import { gitRepo, realRun } from "./helpers";
import { validateStrategy } from "../src/config/strategy";
import { parseEnvelope } from "../src/link/envelope";
import { taskStatus } from "../src/view-model/words";

// A completed turn/report must never terminate a persistent conversation.
for (const status of ["done", "failed", "turn-ended"] as const) {
  test(`conversation ${status} stays alive until explicit stop despite deadline and idle`, async () => {
    let polls = 0, stops = 0;
    const state: RunState = {pid: 123, startedAt: 1, alive: true, exit: null,
      stdoutBytes: 0, stderrBytes: 0, lastOutputAt: null, interactive: true,
      report: {status, summary: "Turn result", at: 2}};
    const result = await supervise({
      interactionMode: "conversation", deadlineMs: 0, now: () => 86400_000,
      io: {read: async () => {polls++; return state;}, stop: async () => {stops++; return {code: 143, killed: false};}},
      isStopped: () => polls >= 3, onPoll: async () => "idle", sleep: async () => {},
    });
    expect(result).toEqual({kind: "stopped", code: 143});
    expect(polls).toBe(3);
    expect(stops).toBe(1);
  });
}

for (const code of [0, 4]) {
  test(`conversation preserves agent exit code ${code}`, async () => {
    const result = await supervise({interactionMode: "conversation", deadlineMs: 0,
      io: {read: async () => ({pid: 123, startedAt: 1, alive: false, exit: code,
        stdoutBytes: 0, stderrBytes: 0, lastOutputAt: null, interactive: true}),
        stop: async () => {throw Error("already exited");}}, isStopped: () => false});
    expect(result).toEqual({kind: "exited", code});
  });
}

test("conversation report does not prevent the next turn's activity hooks", () => {
  const dir = tmpDir();
  writeFileSync(join(dir, "interactive.json"), JSON.stringify({interactionMode: "conversation"}));
  writeReport(dir, "done", "First answer");
  agentHook(dir, {hook_event_name: "UserPromptSubmit"});
  expect(readReport(dir)?.status).toBe("running");
  agentHook(dir, {hook_event_name: "Stop"});
  expect(readReport(dir)?.status).toBe("turn-ended");
  agentHook(dir, {hook_event_name: "PermissionRequest"});
  expect(readReport(dir)?.status).toBe("needs-input");
});

test("detached conversation host survives reports after its supervisor disconnects", async () => {
  const dir = tmpDir();
  const started = startRun({dir, argv: ["sleep", "30"], cwd: dir, env: {PATH: process.env.PATH},
    session: "interactive", interactionMode: "conversation"});
  expect(started).toHaveProperty("pid");
  try {
    for (let i = 0; i < 100 && !(await localRunIO(dir).read()).startedAt; i++) await Bun.sleep(25);
    writeReport(dir, "done", "First turn is finished");
    await Bun.sleep(300);
    const state = await localRunIO(dir).read();
    expect(state.alive).toBe(true);
    expect(state.exit).toBeNull();
  } finally { await stopRun(dir, {graceMs: 500}); }
});

test("idle conversation stays active, occupies a slot and publishes turn activity", async () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, {brief: {goal: "Talk", repo: ctx.home}, kind: null, requestedExecutor: "codex", timeoutS: 30});
  const run = {dir: ctx.home, attempt: 1, executor: "codex", startedAt: 1, mode: "current" as const,
    workdir: ctx.home, logFile: join(ctx.home, "unused"), interactionMode: "conversation" as const};
  updateTask(ctx, task.id, t => {t.state = "running"; t.interactionMode = "conversation"; t.run = run;});
  const poll = progressPoller(ctx, readTask(ctx, task.id)!, run);
  expect(await poll({pid: null, startedAt: 1, alive: true, exit: null, stdoutBytes: 0, stderrBytes: 0,
    lastOutputAt: null, interactive: true, report: {status: "turn-ended", summary: "Answer", at: 2}})).toBe("continue");
  const current = readTask(ctx, task.id)!;
  expect(current.state).toBe("running");
  expect(current.conversation?.activity).toBe("idle");
  expect(taskData(current)).toMatchObject({interactionMode: "conversation", conversation: {activity: "idle"}});
  expect(parseEnvelope({type: "task", data: taskData(current)})).toMatchObject({data: {interactionMode: "conversation", conversation: {activity: "idle"}}});
  expect(taskStatus(taskData(current)).label).toBe("Ready for input");
  expect(slotUse([current])).toMatchObject({byExecutor: {codex: 1}, local: 1});
  expect(eligibleForRetention({...ctx, now: ctx.now + 30 * 86400}, {...current, dismissed: true}, 14)).toBe(false);
});

test("conversation launches interactive per task with original request rather than executor contract", async () => {
  const repo = gitRepo(), bin = tmpDir();
  const executable = join(bin, "cursor-agent");
  writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
  chmodSync(executable, 0o700);
  const ctx = fakeCtx({run: realRun, env: {PATH: `${bin}:${process.env.PATH}`}});
  const task = createTask(ctx, {brief: {goal: "Explain this code", repo}, kind: null, requestedExecutor: "cursor", timeoutS: 1});
  updateTask(ctx, task.id, t => {t.interactionMode = "conversation"; t.state = "running"; t.placement = {requested: "current"};});
  const strategy = validateStrategy({planner: "claude-code", providers: {cursor: {}}}, ctx.home);
  const result = await runAttempt(ctx, strategy.providers.cursor, readTask(ctx, task.id)!);
  expect(result.exec.code).toBe(0);
  expect(result.exec.stdout).toContain("Explain this code");
  expect(result.exec.stdout).not.toContain("--force");
  expect(result.exec.stdout).not.toContain("Executor contract");
  expect(readTask(ctx, task.id)?.run?.interactionMode).toBe("conversation");
});
