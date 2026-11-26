import { childEnv } from "./child-env";
import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { fakeCtx } from "./helpers";
import { createTask, readTask, taskDatabase, updateTask } from "../src/tasks/store";
import { Database } from "bun:sqlite";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);

async function waitExchange(
  home: string,
  taskId: string,
  forward: boolean,
  timeoutS?: number,
  finish = false,
) {
  const params = timeoutS === undefined ? { id: taskId } : { id: taskId, timeout_s: timeoutS };
  const request = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "task.wait", params });
  const child = Bun.spawn([front!, "api", "--stdio"], {
    env: {
      ...childEnv(home),
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
  // A fake executor settles the task while the wait is polling.
  if (finish) {
    void (async () => {
      await Bun.sleep(1200);
      taskDatabase({ ...fakeCtx(), pacerHome: join(home, ".pacer") })
        .query("UPDATE tasks SET state='done', record=json_set(record,'$.state',?,'$.result',json_object('status','done','report','done')) WHERE id=?")
        .run("done", taskId);
    })();
  }
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

async function stopOnce(home: string, taskId: string) {
  const child = Bun.spawn([front!, "api", "--stdio"], {
    env: {
      ...childEnv(home), PATH: process.env.PATH ?? "/usr/bin:/bin", PACER_CORE_ARGV: core,
      PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off",
    },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  await child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } }) + "\n"
    + JSON.stringify({ jsonrpc: "2.0", id: 2, method: "task.stop", params: { id: taskId } }) + "\n");
  await child.stdin.end();
  await child.exited;
}

function brief(home: string, goal: string) {
  return { brief: { goal, repo: home }, kind: null, requestedExecutor: null, timeoutS: 60 };
}

function homes(ctx: ReturnType<typeof fakeCtx>) {
  mkdirSync(join(ctx.pacerHome, "state"), { recursive: true, mode: 0o700 });
  const native = mkdtempSync(join(tmpdir(), "pacer-task-wait-native-"));
  const forward = mkdtempSync(join(tmpdir(), "pacer-task-wait-forward-"));
  cpSync(ctx.home, native, { recursive: true });
  cpSync(ctx.home, forward, { recursive: true });
  return { native, forward };
}

test.skipIf(!front)("native task.wait matches TypeScript for a settled task", async () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, brief(ctx.home, "Wait me"));
  updateTask(ctx, task.id, x => { x.state = "done"; });
  const reference = await callOp(ctx, "task.wait", { id: task.id }) as { state: string };
  const dirs = homes(ctx);
  try {
    const native = await waitExchange(dirs.native, task.id, false);
    const forwarded = await waitExchange(dirs.forward, task.id, true);
    expect(native?.result?.state).toBe("done");
    expect(forwarded?.result?.state).toBe("done");
    expect(native?.result?.task_id).toBe(task.id);
    expect(native?.result?.state).toBe(reference.state);
  } finally {
    rmSync(dirs.native, { recursive: true, force: true });
    rmSync(dirs.forward, { recursive: true, force: true });
  }
});

test.skipIf(!front)("native task.wait follows a queued task to completion", async () => {
  const ctx = fakeCtx({ now: Date.now() / 1000 });
  const task = createTask(ctx, brief(ctx.home, "Finish me"));
  expect(readTask(ctx, task.id)!.state).toBe("queued");
  const dirs = homes(ctx);
  try {
    const native = await waitExchange(dirs.native, task.id, false, 5, true);
    const forwarded = await waitExchange(dirs.forward, task.id, true, 5, true);
    expect(native?.result?.state).toBe("done");
    expect(forwarded?.result?.state).toBe("done");
    expect(native?.result?.state).toBe(forwarded?.result?.state);
  } finally {
    rmSync(dirs.native, { recursive: true, force: true });
    rmSync(dirs.forward, { recursive: true, force: true });
  }
});

test.skipIf(!front)("native task.wait settles promptly after stopping a task with an agent session", async () => {
  const ctx = fakeCtx({ now: Date.now() / 1000 });
  const task = createTask(ctx, brief(ctx.home, "Agent-backed"));
  const db: Database = taskDatabase(ctx);
  db.run("CREATE TABLE IF NOT EXISTS agent_sessions(id TEXT PRIMARY KEY, task TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, record TEXT NOT NULL)");
  db.query("INSERT INTO agent_sessions(id,task,request_id,payload,record) VALUES(?,?,?,?,?)")
    .run("s-1", task.id, "r-1", "{}", JSON.stringify({ id: "s-1", task_id: task.id, state: "running", attempt: 1 }));
  const dirs = homes(ctx);
  try {
    await stopOnce(dirs.native, task.id);
    const started = Date.now();
    const native = await waitExchange(dirs.native, task.id, false, 5);
    expect(native?.result?.state).toBe("stopped");
    expect(Date.now() - started).toBeLessThan(4000);
  } finally {
    rmSync(dirs.native, { recursive: true, force: true });
    rmSync(dirs.forward, { recursive: true, force: true });
  }
});

test.skipIf(!front)("native task.wait returns the active task at timeout_s: 1", async () => {
  const ctx = fakeCtx({ now: Date.now() / 1000 });
  const task = createTask(ctx, brief(ctx.home, "Still queued"));
  const dirs = homes(ctx);
  try {
    const native = await waitExchange(dirs.native, task.id, false, 1);
    const forwarded = await waitExchange(dirs.forward, task.id, true, 1);
    expect(native?.result?.state).toBe("queued");
    expect(native?.result?.state).toBe(forwarded?.result?.state);
  } finally {
    rmSync(dirs.native, { recursive: true, force: true });
    rmSync(dirs.forward, { recursive: true, force: true });
  }
});
