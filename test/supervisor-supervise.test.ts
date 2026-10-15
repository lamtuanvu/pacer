import { expect, test } from "bun:test";
import { startRun } from "../src/supervisor/run";
import { supervise } from "../src/supervisor/supervise";
import { tmpDir } from "./helpers";

const env = { PATH: process.env.PATH };
const fast = { pollMs: 50, graceMs: 500 };

test("exited: the run's own exit code", async () => {
  const dir = tmpDir(); startRun({ dir, argv: ["sh", "-c", "exit 4"], cwd: tmpDir(), env });
  expect(await supervise({ dir, deadlineMs: Date.now() + 5000, isStopped: () => false, ...fast })).toEqual({ kind: "exited", code: 4 });
});

test("timeout stops the run", async () => {
  const dir = tmpDir(); startRun({ dir, argv: ["sleep", "30"], cwd: tmpDir(), env });
  expect(await supervise({ dir, deadlineMs: Date.now() + 300, isStopped: () => false, ...fast })).toEqual({ kind: "timeout", code: 143 });
});

test("stopped when the task is stopped", async () => {
  const dir = tmpDir(); startRun({ dir, argv: ["sleep", "30"], cwd: tmpDir(), env });
  let n = 0;
  expect(await supervise({ dir, deadlineMs: Date.now() + 10_000, isStopped: () => ++n > 2, ...fast })).toEqual({ kind: "stopped", code: 143 });
});

test("idle when onPoll says so", async () => {
  const dir = tmpDir(); startRun({ dir, argv: ["sleep", "30"], cwd: tmpDir(), env });
  expect(await supervise({ dir, deadlineMs: Date.now() + 10_000, isStopped: () => false, onPoll: async () => "idle", ...fast })).toEqual({ kind: "idle", code: 143 });
});

test("lost when the wrapper vanished without an exit record", async () => {
  const dir = tmpDir(); const r = startRun({ dir, argv: ["sleep", "30"], cwd: tmpDir(), env }) as { pid: number };
  process.kill(-r.pid, "SIGKILL");
  expect(await supervise({ dir, deadlineMs: Date.now() + 5000, isStopped: () => false, ...fast })).toEqual({ kind: "lost", code: 137 });
});
