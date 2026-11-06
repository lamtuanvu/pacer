import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { taskReviewProbe } from "../src/api/task-review-bridge";
import { fakeCtx } from "./helpers";
import { createTask, readTask, updateTask } from "../src/tasks/store";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);

async function reviewExchange(
  home: string,
  taskId: string,
  rev: number,
  forward: boolean,
  verdict: "accept" | "reject" = "accept",
) {
  const request = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "task.review",
    params: { id: taskId, expect_rev: rev, verdict },
  });
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
      ...(forward ? { PACER_FORWARD_OPS: "task.review" } : {}),
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    await child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } }) + "\n" + request + "\n",
    );
    await child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, stderr).toBe(0);
    const replies = stdout.trim().split("\n").map(line => JSON.parse(line));
    const markers = stderr.split("\n").filter(line => /^native task\.review \d+$/.test(line));
    expect(markers).toEqual(forward ? [] : ["native task.review 2"]);
    return replies[1];
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await child.exited;
    }
  }
}

test("taskReviewProbe allows native accept for a simple done task", () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, { brief: { goal: "g", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, task.id, t => { t.state = "done"; });
  expect(taskReviewProbe(ctx, task.id, { verdict: "accept" })).toEqual({ forward: false });
});

test("taskReviewProbe forwards send_back and retry", () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, { brief: { goal: "g", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  expect(taskReviewProbe(ctx, task.id, { verdict: "send_back" })).toEqual({ forward: true, reason: "verdict" });
  expect(taskReviewProbe(ctx, task.id, { verdict: "retry" })).toEqual({ forward: true, reason: "verdict" });
});

test.skipIf(!front)("native task.review matches TypeScript for accept on a non-managed task", async () => {
  const ctx = fakeCtx();
  mkdirSync(join(ctx.pacerHome, "state"), { recursive: true, mode: 0o700 });
  const task = createTask(ctx, { brief: { goal: "Review me", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, task.id, t => { t.state = "done"; });
  const rev = readTask(ctx, task.id)!.rev;
  const reference = await callOp(ctx, "task.review", { id: task.id, expect_rev: rev, verdict: "accept" }) as { task: { rev: number } };
  const nativeHome = mkdtempSync(join(tmpdir(), "pacer-task-review-native-"));
  const forwardHome = mkdtempSync(join(tmpdir(), "pacer-task-review-forward-"));
  cpSync(ctx.home, nativeHome, { recursive: true });
  cpSync(ctx.home, forwardHome, { recursive: true });
  try {
    const native = await reviewExchange(nativeHome, task.id, rev, false, "accept");
    const forwarded = await reviewExchange(forwardHome, task.id, rev, true, "accept");
    expect(native?.result?.task?.id).toBe(task.id);
    expect(native?.result?.task?.review?.accepted).toBe(true);
    expect(forwarded?.result?.task?.review?.accepted).toBe(true);
    expect(native?.result?.task?.rev).toBe(reference.task.rev);
  } finally {
    rmSync(nativeHome, { recursive: true, force: true });
    rmSync(forwardHome, { recursive: true, force: true });
  }
});
