import { childEnv } from "./child-env";
import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { callOp } from "../src/api/ops";
import { fakeCtx } from "./helpers";
import { createTask, readTask, taskDatabase, updateTask } from "../src/tasks/store";
import { dispatchDatabase } from "../src/dispatch/store";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);

async function stopExchange(home: string, taskId: string, rev: number, forward: boolean) {
  const request = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "task.stop", params: { id: taskId, expect_rev: rev } });
  const child = Bun.spawn([front!, "api", "--stdio"], {
    env: {
      ...childEnv(home),
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

function brief(home: string, goal: string) {
  return { brief: { goal, repo: home }, kind: null, requestedExecutor: null, timeoutS: 60 };
}

function homes(ctx: ReturnType<typeof fakeCtx>) {
  mkdirSync(join(ctx.pacerHome, "state"), { recursive: true, mode: 0o700 });
  const native = mkdtempSync(join(tmpdir(), "pacer-task-stop-native-"));
  const forward = mkdtempSync(join(tmpdir(), "pacer-task-stop-forward-"));
  cpSync(ctx.home, native, { recursive: true });
  cpSync(ctx.home, forward, { recursive: true });
  return { native, forward };
}

function liveRunner() {
  return Bun.spawn(["sleep", "30"], { detached: true, stdout: "ignore", stderr: "ignore" });
}

async function gone(child: ReturnType<typeof Bun.spawn>) {
  for (let i = 0; i < 20; i++) {
    try {
      execFileSync("ps", ["-p", String(child.pid)], { stdio: "ignore" });
    } catch {
      return true;
    }
    await Bun.sleep(100);
  }
  return false;
}

test.skipIf(!front)("native task.stop matches TypeScript for a non-managed task", async () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, brief(ctx.home, "Stop me"));
  const rev = readTask(ctx, task.id)!.rev;
  const dirs = homes(ctx);
  const reference = await callOp(ctx, "task.stop", { id: task.id, expect_rev: rev }) as { state: string };
  try {
    const native = await stopExchange(dirs.native, task.id, rev, false);
    const forwarded = await stopExchange(dirs.forward, task.id, rev, true);
    expect(native?.result?.state).toBe("stopped");
    expect(forwarded?.result?.state).toBe("stopped");
    expect(native?.result?.task_id).toBe(task.id);
    expect(native?.result?.state).toBe(reference.state);
  } finally {
    rmSync(dirs.native, { recursive: true, force: true });
    rmSync(dirs.forward, { recursive: true, force: true });
  }
});

test.skipIf(!front)("native task.stop kills a running task's process group", async () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, brief(ctx.home, "Stop the runner"));
  const nativeRunner = liveRunner();
  const forwardRunner = liveRunner();
  updateTask(ctx, task.id, t => {
    t.state = "running";
    t.childPid = nativeRunner.pid;
    t.runnerPid = nativeRunner.pid;
  });
  const rev = readTask(ctx, task.id)!.rev;
  const dirs = homes(ctx);
  // Each door kills its own runner, so point the forwarded copy at its own pid.
  taskDatabase({ ...fakeCtx(), pacerHome: join(dirs.forward, ".pacer") })
    .query("UPDATE tasks SET record=json_set(record,'$.childPid',?,'$.runnerPid',?) WHERE id=?")
    .run(forwardRunner.pid, forwardRunner.pid, task.id);
  try {
    const native = await stopExchange(dirs.native, task.id, rev, false);
    const forwarded = await stopExchange(dirs.forward, task.id, rev, true);
    expect(native?.result?.state).toBe("stopped");
    expect(forwarded?.result?.state).toBe("stopped");
    expect(native?.result?.state).toBe(forwarded?.result?.state);
    expect(await gone(nativeRunner), "native stop killed the runner").toBe(true);
    expect(await gone(forwardRunner), "forwarded stop killed the runner").toBe(true);
  } finally {
    for (const child of [nativeRunner, forwardRunner]) {
      if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    }
    rmSync(dirs.native, { recursive: true, force: true });
    rmSync(dirs.forward, { recursive: true, force: true });
  }
});

test.skipIf(!front)("native task.stop stops a managed root and both children", async () => {
  const ctx = fakeCtx();
  const root = createTask(ctx, brief(ctx.home, "root"));
  const a = createTask({ ...ctx, now: ctx.now + 1 }, brief(ctx.home, "child a"));
  const b = createTask({ ...ctx, now: ctx.now + 2 }, brief(ctx.home, "child b"));
  const db = dispatchDatabase(ctx);
  for (const [id, parent] of [[root.id, null], [a.id, root.id], [b.id, root.id]] as const) {
    db.query("INSERT INTO work_nodes(task_id,parent_id,root_id,depth,options,dependencies) VALUES(?,?,?,?,?,?)")
      .run(id, parent, root.id, parent ? 1 : 0, "{}", "[]");
  }
  const rev = readTask(ctx, root.id)!.rev;
  const dirs = homes(ctx);
  try {
    const native = await stopExchange(dirs.native, root.id, rev, false);
    const forwarded = await stopExchange(dirs.forward, root.id, rev, true);
    expect(native?.result?.state).toBe("stopped");
    expect(native?.result?.state).toBe(forwarded?.result?.state);
    for (const id of [root.id, a.id, b.id]) {
      const n = taskDatabase({ ...fakeCtx(), pacerHome: join(dirs.native, ".pacer") })
        .query<{ record: string }, [string]>("SELECT record FROM tasks WHERE id=?").get(id)!;
      const f = taskDatabase({ ...fakeCtx(), pacerHome: join(dirs.forward, ".pacer") })
        .query<{ record: string }, [string]>("SELECT record FROM tasks WHERE id=?").get(id)!;
      expect(JSON.parse(n.record).state, `native ${id}`).toBe("stopped");
      expect(JSON.parse(f.record).state, `forwarded ${id}`).toBe("stopped");
    }
  } finally {
    rmSync(dirs.native, { recursive: true, force: true });
    rmSync(dirs.forward, { recursive: true, force: true });
  }
});

test.skipIf(!front)("native task.stop settles a task with an active agent session", async () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, brief(ctx.home, "Has an agent"));
  const db: Database = taskDatabase(ctx);
  db.run("CREATE TABLE IF NOT EXISTS agent_sessions(id TEXT PRIMARY KEY, task TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, record TEXT NOT NULL)");
  db.query("INSERT INTO agent_sessions(id,task,request_id,payload,record) VALUES(?,?,?,?,?)")
    .run("s-1", task.id, "r-1", "{}", JSON.stringify({ id: "s-1", task_id: task.id, state: "running", attempt: 1 }));
  const rev = readTask(ctx, task.id)!.rev;
  const dirs = homes(ctx);
  try {
    const native = await stopExchange(dirs.native, task.id, rev, false);
    const forwarded = await stopExchange(dirs.forward, task.id, rev, true);
    expect(native?.result?.state).toBe("stopped");
    expect(native?.result?.state).toBe(forwarded?.result?.state);
  } finally {
    rmSync(dirs.native, { recursive: true, force: true });
    rmSync(dirs.forward, { recursive: true, force: true });
  }
});
