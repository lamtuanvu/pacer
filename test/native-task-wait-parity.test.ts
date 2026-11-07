import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { taskWaitProbe } from "../src/api/task-wait-bridge";
import { fakeCtx } from "./helpers";
import { createTask, readTask, updateTask } from "../src/tasks/store";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);

async function waitExchange(home: string, taskId: string, forward: boolean) {
  const request = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "task.wait", params: { id: taskId } });
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
      ...(forward ? { PACER_FORWARD_OPS: "task.wait" } : {}),
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
    const markers = stderr.split("\n").filter(line => /^native task\.wait \d+$/.test(line));
    expect(markers).toEqual(forward ? [] : ["native task.wait 2"]);
    return replies[1];
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await child.exited;
    }
  }
}

test("taskWaitProbe allows native wait for a settled done task", () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, { brief: { goal: "g", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, task.id, x => { x.state = "done"; });
  expect(taskWaitProbe(ctx, task.id)).toEqual({ forward: false, reason: "settled" });
});

test("taskWaitProbe forwards for a running task", () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, { brief: { goal: "g", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  expect(taskWaitProbe(ctx, task.id)).toEqual({ forward: true, reason: "not settled" });
});

test.skipIf(!front)("native task.wait matches TypeScript for a settled task", async () => {
  const ctx = fakeCtx();
  mkdirSync(join(ctx.pacerHome, "state"), { recursive: true, mode: 0o700 });
  const task = createTask(ctx, { brief: { goal: "Wait me", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, task.id, x => { x.state = "done"; });
  const reference = await callOp(ctx, "task.wait", { id: task.id }) as { state: string };
  const nativeHome = mkdtempSync(join(tmpdir(), "pacer-task-wait-native-"));
  const forwardHome = mkdtempSync(join(tmpdir(), "pacer-task-wait-forward-"));
  cpSync(ctx.home, nativeHome, { recursive: true });
  cpSync(ctx.home, forwardHome, { recursive: true });
  try {
    const native = await waitExchange(nativeHome, task.id, false);
    const forwarded = await waitExchange(forwardHome, task.id, true);
    expect(native?.result?.state).toBe("done");
    expect(forwarded?.result?.state).toBe("done");
    expect(native?.result?.task_id).toBe(task.id);
    expect(native?.result?.state).toBe((reference as { state: string }).state);
  } finally {
    rmSync(nativeHome, { recursive: true, force: true });
    rmSync(forwardHome, { recursive: true, force: true });
  }
});
