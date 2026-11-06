import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { taskStopProbe } from "../src/api/task-stop-bridge";
import { fakeCtx } from "./helpers";
import { createTask, readTask } from "../src/tasks/store";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);

async function stopExchange(home: string, taskId: string, rev: number, forward: boolean) {
  const request = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "task.stop", params: { id: taskId, expect_rev: rev } });
  const child = Bun.spawn([front!, "api", "--stdio"], {
    env: {
      HOME: home,
      PACER_HOME: join(home, ".pacer"),
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      PACER_CORE_ARGV: core,
      PACER_NO_UPDATE_CHECK: "1",
      PACER_NO_SELF_REPAIR: "1",
      PACER_DISCOVERY: "off",
      PACER_DEBUG_NATIVE: "1",
      ...(forward ? { PACER_FORWARD_OPS: "task.stop" } : {}),
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    await child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } }) + "\n" + request + "\n");
    await child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    const replies = stdout.trim().split("\n").map(line => JSON.parse(line));
    const markers = stderr.split("\n").filter(line => /^native task\.stop \d+$/.test(line));
    expect(markers).toEqual(forward ? [] : ["native task.stop 2"]);
    return replies[1];
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await child.exited;
    }
  }
}

test("taskStopProbe allows native stop for a simple queued task", () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, { brief: { goal: "g", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  expect(taskStopProbe(ctx, task.id)).toEqual({ forward: false, runnerAlive: false, beforeState: "queued" });
});

test.skipIf(!front)("native task.stop matches TypeScript for a non-managed task", async () => {
  const ctx = fakeCtx();
  mkdirSync(join(ctx.pacerHome, "state"), { recursive: true, mode: 0o700 });
  const task = createTask(ctx, { brief: { goal: "Stop me", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const rev = readTask(ctx, task.id)!.rev;
  const reference = await callOp(ctx, "task.stop", { id: task.id, expect_rev: rev });
  const nativeHome = mkdtempSync(join(tmpdir(), "pacer-task-stop-native-"));
  const forwardHome = mkdtempSync(join(tmpdir(), "pacer-task-stop-forward-"));
  cpSync(ctx.home, nativeHome, { recursive: true });
  cpSync(ctx.home, forwardHome, { recursive: true });
  try {
    const native = await stopExchange(nativeHome, task.id, rev, false);
    const forwarded = await stopExchange(forwardHome, task.id, rev, true);
    expect(native?.result?.state).toBe("stopped");
    expect(forwarded?.result?.state).toBe("stopped");
    expect(native?.result?.task_id).toBe(task.id);
    expect(native?.result?.state).toBe((reference as { state: string }).state);
  } finally {
    rmSync(nativeHome, { recursive: true, force: true });
    rmSync(forwardHome, { recursive: true, force: true });
  }
});
