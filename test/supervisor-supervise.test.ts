import { expect, test } from "bun:test";
import { localRunIO, startRun } from "../src/supervisor/run";
import { supervise } from "../src/supervisor/supervise";
import { tmpDir } from "./helpers";

const env = { PATH: process.env.PATH };
const fast = { pollMs: 50, graceMs: 500 };

test("exited: the run's own exit code", async () => {
  const dir = tmpDir(); startRun({ dir, argv: ["sh", "-c", "exit 4"], cwd: tmpDir(), env });
  expect(await supervise({ io: localRunIO(dir), deadlineMs: Date.now() + 5000, isStopped: () => false, ...fast })).toEqual({ kind: "exited", code: 4 });
});

test("timeout stops the run", async () => {
  const dir = tmpDir(); startRun({ dir, argv: ["sleep", "30"], cwd: tmpDir(), env });
  expect(await supervise({ io: localRunIO(dir), deadlineMs: Date.now() + 300, isStopped: () => false, ...fast })).toEqual({ kind: "timeout", code: 143 });
});

test("stopped when the task is stopped", async () => {
  const dir = tmpDir(); startRun({ dir, argv: ["sleep", "30"], cwd: tmpDir(), env });
  let n = 0;
  expect(await supervise({ io: localRunIO(dir), deadlineMs: Date.now() + 10_000, isStopped: () => ++n > 2, ...fast })).toEqual({ kind: "stopped", code: 143 });
});

test("idle when onPoll says so", async () => {
  const dir = tmpDir(); startRun({ dir, argv: ["sleep", "30"], cwd: tmpDir(), env });
  expect(await supervise({ io: localRunIO(dir), deadlineMs: Date.now() + 10_000, isStopped: () => false, onPoll: async () => "idle", ...fast })).toEqual({ kind: "idle", code: 143 });
});

test("lost when the wrapper vanished without an exit record", async () => {
  const dir = tmpDir(); const r = startRun({ dir, argv: ["sleep", "30"], cwd: tmpDir(), env }) as { pid: number };
  process.kill(-r.pid, "SIGKILL");
  expect(await supervise({ io: localRunIO(dir), deadlineMs: Date.now() + 5000, isStopped: () => false, ...fast })).toEqual({ kind: "lost", code: 137 });
});

for (const status of ["done", "failed"] as const) {
  test(`interactive ${status} report stops the TUI and supplies the result code`, async () => {
    let stopped = false;
    const io = {
      read: async () => ({pid: 123, startedAt: 1, alive: true, exit: null, stdoutBytes: 0, stderrBytes: 0, lastOutputAt: null, interactive: true, report: {status, summary: "Explicit result", at: 2}}),
      stop: async () => {stopped = true; return {code: 143, killed: false};},
    };
    expect(await supervise({io, deadlineMs: Date.now() + 5000, isStopped: () => false, ...fast}))
      .toEqual({kind: "reported", code: status === "done" ? 0 : 1});
    expect(stopped).toBe(true);
  });
}

test("a clean interactive exit without an explicit report is not success", async () => {
  const dir = tmpDir();
  startRun({dir, argv: ["sh", "-c", "echo done; exit 0"], cwd: dir, env, session: "interactive"});
  while ((await localRunIO(dir).read()).exit === null) await Bun.sleep(25);
  expect(await supervise({io: localRunIO(dir), deadlineMs: Date.now() + 5000, isStopped: () => false, ...fast}))
    .toEqual({kind: "exited", code: 1});
});

test("asked when onPoll says the executor asked and ended its turn", async () => {
  const dir = tmpDir(); startRun({ dir, argv: ["sleep", "30"], cwd: tmpDir(), env });
  expect(await supervise({ io: localRunIO(dir), deadlineMs: Date.now() + 10_000, isStopped: () => false, onPoll: async () => "asked", ...fast })).toEqual({ kind: "asked", code: 143 });
});
