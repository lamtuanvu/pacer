import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { taskStop } from "../src/tasks/api";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { fakeCtx } from "./helpers";

const ROOT = join(import.meta.dir, "..");
const TARGET = join(ROOT, "target");

function rustStop(
  pacerHome: string,
  id: string,
  expectRev: number | null,
  now: number,
  runnerAlive: boolean,
) {
  execFileSync("cargo", ["build", "-q", "-p", "pacer-lifecycle", "--bin", "record_stop_probe"], {
    cwd: ROOT,
    env: { ...process.env, CARGO_TARGET_DIR: TARGET },
  });
  const probe = join(TARGET, "debug", "record_stop_probe");
  const out = execFileSync(
    probe,
    [
      pacerHome,
      id,
      expectRev === null ? "" : String(expectRev),
      String(now),
      runnerAlive ? "1" : "0",
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(out) as { state: string; rev: number; result?: { report?: string }; stopPending?: { reason: string } };
}

test("record_task_stop matches taskStop store fields without signals", () => {
  const ctx = fakeCtx();
  const t = createTask(ctx, {
    brief: { goal: "g", repo: ctx.home },
    kind: null,
    requestedExecutor: null,
    timeoutS: 60,
  });
  taskStop(ctx, t.id, { signal: false });
  const ts = readTask(ctx, t.id)!;
  expect(ts.state).toBe("stopped");
  expect(ts.result?.report).toBe("stopped before an executor ran");

  const other = fakeCtx();
  const seeded = createTask(other, {
    brief: { goal: "g", repo: other.home },
    kind: null,
    requestedExecutor: null,
    timeoutS: 60,
  });
  const rust = rustStop(other.pacerHome, seeded.id, readTask(other, seeded.id)!.rev, other.now, false);
  expect(rust.state).toBe("stopped");
  expect(rust.result?.report).toBe("stopped before an executor ran");
});

test("record_task_stop sets stopPending for running provider tasks", () => {
  const ctx = fakeCtx();
  const t = createTask(ctx, {
    brief: { goal: "g", repo: ctx.home },
    kind: null,
    requestedExecutor: null,
    timeoutS: 60,
  });
  updateTask(ctx, t.id, (x) => {
    x.state = "running";
    x.executorProvider = "pacer-exec-direct";
    x.run = { host: "h", mode: "new", attempt: 1, dir: "d" } as typeof x.run;
  });
  const stopped = taskStop(ctx, t.id, { signal: false })!;
  expect(stopped.stopPending?.reason).toBe("user");

  const other = fakeCtx();
  const seeded = createTask(other, {
    brief: { goal: "g", repo: other.home },
    kind: null,
    requestedExecutor: null,
    timeoutS: 60,
  });
  updateTask(other, seeded.id, (x) => {
    x.state = "running";
    x.executorProvider = "pacer-exec-direct";
    x.run = { host: "h", mode: "new", attempt: 1, dir: "d" } as typeof x.run;
  });
  const rust = rustStop(other.pacerHome, seeded.id, readTask(other, seeded.id)!.rev, other.now, true);
  expect(rust.state).toBe("running");
  expect(rust.stopPending?.reason).toBe("user");
});
