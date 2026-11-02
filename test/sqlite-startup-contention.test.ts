import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import { join } from "node:path";
import { createTask, readTask, tasksDir, updateTask } from "../src/tasks/store";
import { dispatchDatabase } from "../src/dispatch/store";
import { startServer } from "../src/serve/http";
import { backfillTaskHistory, maintainTaskHistory, startTaskHistory } from "../src/tasks/history";
import { fakeCtx } from "./helpers";
import { backfillFirstSettled } from "../src/insights/summary";

const input = { brief: { goal: "contention fixture", repo: "/tmp/repo" }, kind: null, requestedExecutor: null, timeoutS: 60 };

test("a fresh reader can read a migrated store while another process owns the writer", async () => {
  const ctx = fakeCtx(), task = createTask(ctx, input);
  const writer = new Database(join(ctx.pacerHome, "state/tasks.db"));
  writer.exec("BEGIN IMMEDIATE");
  const script = `import { readTask } from ${JSON.stringify(new URL("../src/tasks/store.ts", import.meta.url).pathname)};
    const task = readTask(JSON.parse(process.argv[1]), process.argv[2]);
    console.log(task?.id);`;
  const child = Bun.spawn([process.execPath, "-e", script, JSON.stringify(ctx), task.id], { stdout: "pipe", stderr: "pipe" });
  try {
    const result = await Promise.race([child.exited, Bun.sleep(1500).then(() => "blocked")]);
    expect(result).toBe(0);
    expect((await new Response(child.stdout).text()).trim()).toBe(task.id);
  } finally {
    writer.exec("ROLLBACK"); writer.close();
    child.kill(); await child.exited;
  }
}, 10000);

test("legacy JSON filesystem reads do not hold the database writer lock", () => {
  const ctx = fakeCtx(), task = createTask(ctx, input);
  const dir = tasksDir(ctx), file = join(dir, `${task.id}.json`), tmp = `${file}.older.tmp`;
  const fileMtime = fs.statSync(file).mtimeMs, dirMtime = fs.statSync(dir).mtimeMs;
  // The importer must see both changes even when rename shares a filesystem clock tick.
  const changedAt = new Date(Math.max(fileMtime, dirMtime) + 1000);
  fs.writeFileSync(tmp, JSON.stringify({ ...task, rev: 2, title: "legacy update" }));
  fs.utimesSync(tmp, changedAt, changedAt);
  fs.renameSync(tmp, file);
  fs.utimesSync(dir, changedAt, changedAt);
  expect(fs.statSync(file).mtimeMs).toBeGreaterThan(fileMtime);
  expect(fs.statSync(dir).mtimeMs).toBeGreaterThan(dirMtime);
  const writer = new Database(join(ctx.pacerHome, "state/tasks.db"));
  writer.exec("PRAGMA busy_timeout=0");
  let observed = false;
  const original = fs.readFileSync;
  const read = spyOn(fs, "readFileSync").mockImplementation(((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (path === file) {
      observed = true;
      writer.exec("BEGIN IMMEDIATE");
      writer.exec("ROLLBACK");
    }
    return (original as (...args: unknown[]) => unknown)(path, ...args);
  }) as typeof fs.readFileSync);
  try {
    expect(readTask(ctx, task.id)).toMatchObject({ rev: 2, title: "legacy update" });
    expect(observed).toBe(true);
  } finally { read.mockRestore(); writer.close(); }
});

test("historical backfill commits bounded batches and safely resumes after interruption", () => {
  const ctx = fakeCtx();
  const ids: string[] = [];
  for (let i = 0; i < 65; i++) {
    const when = { ...ctx, now: ctx.now + i };
    const task = createTask(when, input);
    updateTask(when, task.id, t => { t.state = "done"; });
    ids.push(task.id);
  }
  const db = dispatchDatabase(ctx);
  db.exec("DELETE FROM task_first_settle");
  db.exec(`CREATE TRIGGER interrupt_history BEFORE INSERT ON task_first_settle WHEN NEW.task_id='${ids[0]}' BEGIN SELECT RAISE(ABORT, 'interrupted batch'); END`);
  expect(() => backfillFirstSettled(ctx)).toThrow("interrupted batch");
  expect(db.query("SELECT count(*) AS n FROM task_first_settle").get()).toEqual({ n: 64 });
  db.exec("DROP TRIGGER interrupt_history");
  expect(backfillFirstSettled(ctx)).toBe(1);
  expect(backfillFirstSettled(ctx)).toBe(0);
});

test("history backfill contention cannot delay listener startup or session exchange", async () => {
  const ctx = fakeCtx({ now: Date.now() / 1000 });
  createTask(ctx, input);
  dispatchDatabase(ctx);
  const writer = new Database(join(ctx.pacerHome, "state/tasks.db"));
  writer.exec("BEGIN IMMEDIATE");
  let service: ReturnType<typeof startServer> | undefined;
  try {
    const started = performance.now();
    service = startServer(() => ctx, { port: 0, pumpMs: 0 });
    expect(performance.now() - started).toBeLessThan(1000);
    const response = await fetch(`http://127.0.0.1:${service.port}/v3/session/exchange`, {
      method: "POST", headers: { authorization: `Bearer ${service.token}`, "x-pacer-client": "desktop/test" },
      signal: AbortSignal.timeout(1500),
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  } finally {
    writer.exec("ROLLBACK"); writer.close();
    await service?.stop();
  }
}, 15000);

test("history retries a temporary writer lock and completes after release", async () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, input);
  updateTask(ctx, task.id, t => { t.state = "done"; });
  const db = dispatchDatabase(ctx);
  db.exec("DELETE FROM task_first_settle");
  db.exec("PRAGMA busy_timeout=0");
  const writer = new Database(join(ctx.pacerHome, "state/tasks.db"));
  writer.exec("BEGIN IMMEDIATE");
  let released = false;
  const release = setTimeout(() => { writer.exec("ROLLBACK"); released = true; }, 150);
  try {
    await backfillTaskHistory(ctx);
    expect(released).toBe(true);
    expect(db.query("SELECT count(*) AS n FROM task_first_settle").get()).toEqual({ n: 1 });
  } finally {
    clearTimeout(release);
    if (!released) writer.exec("ROLLBACK");
    writer.close();
  }
});

test("history reports non-contention database failures instead of hiding them", async () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, input);
  const db = dispatchDatabase(ctx);
  db.exec(`CREATE TRIGGER reject_history BEFORE INSERT ON task_first_settle BEGIN SELECT RAISE(ABORT, 'history fixture failure'); END`);
  db.query("UPDATE tasks SET record=json_set(record,'$.settledAt',?) WHERE id=?").run(ctx.now, task.id);
  await expect(backfillTaskHistory(ctx)).rejects.toThrow("history fixture failure");
});

test("failed historical indexing does not prevent independent retention", async () => {
  const ctx = fakeCtx(), old = { ...ctx, now: ctx.now - 30 * 86400 };
  const task = createTask(old, input);
  updateTask(old, task.id, t => { t.state = "done"; t.dismissed = true; });
  const broken = createTask(ctx, input), db = dispatchDatabase(ctx);
  db.exec(`CREATE TRIGGER reject_one_history BEFORE INSERT ON task_first_settle WHEN NEW.task_id='${broken.id}' BEGIN SELECT RAISE(ABORT, 'history fixture failure'); END`);
  db.query("UPDATE tasks SET record=json_set(record,'$.settledAt',?) WHERE id=?").run(ctx.now, broken.id);
  await expect(maintainTaskHistory(ctx)).rejects.toThrow("history fixture failure");
  expect(readTask(ctx, task.id)?.archived).toBe(true);
});

test("a signalled maintenance worker can be replaced on the next scheduled run", async () => {
  const ctx = fakeCtx();
  let daily: (() => void) | undefined;
  const interval = globalThis.setInterval;
  const timers = spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms: number) => {
    if (ms === 86400_000) daily = fn;
    return interval(fn, ms);
  }) as typeof setInterval);
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const spawn = Bun.spawn;
  const spawning = spyOn(Bun, "spawn").mockImplementation(((argv: string[], options: unknown) => {
    const child = (spawn as (...args: any[]) => ReturnType<typeof Bun.spawn>)(argv, options);
    if (argv.includes("_task-history")) children.push(child);
    return child;
  }) as typeof Bun.spawn);
  const worker = startTaskHistory(ctx);
  try {
    const deadline = Date.now() + 2000;
    while (!children.length && Date.now() < deadline) await Bun.sleep(10);
    expect(children).toHaveLength(1);
    daily!();
    expect(children).toHaveLength(1);
    children[0]!.kill("SIGTERM");
    await children[0]!.exited;
    daily!();
    expect(children).toHaveLength(2);
  } finally {
    await worker.stop();
    expect(children.at(-1)?.signalCode).toBe("SIGTERM");
    spawning.mockRestore(); timers.mockRestore();
    for (const child of children) { child.kill(); await child.exited; }
  }
}, 10000);

test("the maintenance worker exits when its service ownership pipe closes", async () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, input);
  updateTask(ctx, task.id, t => { t.state = "done"; });
  dispatchDatabase(ctx).exec("DELETE FROM task_first_settle");
  const writer = new Database(join(ctx.pacerHome, "state/tasks.db"));
  writer.exec("BEGIN IMMEDIATE");
  const parent = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/history-parent.ts")], {
    env: { ...process.env, HOME: ctx.home, PACER_HOME: ctx.pacerHome },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  let pid: number | undefined;
  const alive = () => { try { process.kill(pid!, 0); return true; } catch { return false; } };
  try {
    const reader = parent.stdout.getReader();
    const line = await reader.read();
    pid = JSON.parse(new TextDecoder().decode(line.value)).worker;
    reader.releaseLock();
    expect(alive()).toBe(true);
    // Keep the SQL writer held: without parent EOF, backfill cannot complete
    // naturally until its >20s retry budget has elapsed.
    parent.stdin.end();
    expect(await parent.exited).toBe(0);
    const deadline = Date.now() + 8000;
    while (alive() && Date.now() < deadline) await Bun.sleep(20);
    expect(alive()).toBe(false);
  } finally {
    writer.exec("ROLLBACK"); writer.close();
    parent.kill(); await parent.exited;
    if (pid && alive()) process.kill(pid, "SIGKILL");
  }
}, 15000);
