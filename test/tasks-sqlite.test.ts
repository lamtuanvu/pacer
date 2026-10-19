import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync, renameSync, utimesSync } from "node:fs";
import * as fs from "node:fs";
import { join } from "node:path";
import * as store from "../src/tasks/store";
import { fakeCtx } from "./helpers";

const input = { brief: { goal: "g", repo: "/tmp/repo" }, kind: null, requestedExecutor: null, timeoutS: 60 };

test("SQLite uses private files, WAL, indexes, and derived columns", () => {
  const ctx = fakeCtx(), task = store.createTask(ctx, input);
  const file = join(ctx.pacerHome, "state/tasks.db");
  expect(existsSync(file)).toBe(true);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(join(ctx.pacerHome, "state")).mode & 0o777).toBe(0o700);
  const db = new Database(file);
  expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
  store.updateTask({ ...ctx, now: ctx.now + 10 }, task.id, t => { t.state = "done"; });
  expect(db.query("SELECT rev, state, created_at, updated_at, settled_at, repo FROM tasks").get()).toEqual({
    rev: 2, state: "done", created_at: ctx.now, updated_at: ctx.now + 10, settled_at: ctx.now + 10, repo: input.brief.repo,
  });
  expect(db.query("PRAGMA index_list(tasks)").all().length).toBeGreaterThanOrEqual(4);
  db.close();
});

test("legacy import is non-destructive, idempotent across opens, and tolerates corrupt files", async () => {
  const ctx = fakeCtx(), dir = store.tasksDir(ctx);
  mkdirSync(dir, { recursive: true });
  const id = "t-20261019-120000-abcd", file = join(dir, `${id}.json`);
  const task = { ...input, id, createdAt: ctx.now, state: "queued" as const, attempts: [] };
  writeFileSync(file, JSON.stringify(task));
  const broken = join(dir, "t-20261019-120001-abcd.json");
  writeFileSync(broken, "{broken");
  writeFileSync(join(dir, "keep.log"), "log");
  const before = readdirSync(dir).map(name => ({ name, bytes: readFileSync(join(dir, name)), stat: statSync(join(dir, name)) }));
  const dirBefore = statSync(dir);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(store.readTask(ctx, id)).toEqual({ ...task, rev: 1 });
    expect(warn).toHaveBeenCalled();
  } finally { warn.mockRestore(); }
  expect(readdirSync(dir)).toEqual(before.map(f => f.name));
  expect(statSync(dir).mtimeMs).toBe(dirBefore.mtimeMs);
  for (const f of before) {
    expect(readFileSync(join(dir, f.name))).toEqual(f.bytes);
    expect(statSync(join(dir, f.name)).mtimeMs).toBe(f.stat.mtimeMs);
    expect(statSync(join(dir, f.name)).ino).toBe(f.stat.ino);
  }
  expect(existsSync(broken)).toBe(true);
  expect(readFileSync(join(dir, "keep.log"), "utf8")).toBe("log");
  store.updateTask(ctx, id, t => { t.title = "newer"; });
  // An older restored revision cannot replace a newer SQLite revision.
  writeFileSync(file, JSON.stringify(task));
  const script = `import { listTasks } from ${JSON.stringify(new URL("../src/tasks/store.ts", import.meta.url).pathname)}; console.log(JSON.stringify(listTasks({pacerHome:process.argv[1]})));`;
  const child = Bun.spawn([process.execPath, "-e", script, ctx.pacerHome], { stdout: "pipe", stderr: "pipe" });
  const rows = JSON.parse(await new Response(child.stdout).text());
  expect(await child.exited).toBe(0);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ title: "newer", rev: 2 });
  expect(existsSync(file)).toBe(true);
});

test("indexed filters combine states, update cutoff and limit, preserving newest first", () => {
  const ctx = fakeCtx();
  const old = store.createTask(ctx, input);
  const next = store.createTask({ ...ctx, now: ctx.now + 1 }, input);
  const newest = store.createTask({ ...ctx, now: ctx.now + 2 }, input);
  store.updateTask({ ...ctx, now: ctx.now + 10 }, old.id, t => { t.state = "running"; });
  store.updateTask({ ...ctx, now: ctx.now + 11 }, newest.id, t => { t.state = "done"; });
  expect(store.listTasksWhere(ctx, { updatedSince: ctx.now + 10 }).map(t => t.id)).toEqual([newest.id, old.id]);
  expect(store.listTasksWhere(ctx, { states: ["running", "done"], updatedSince: ctx.now + 10, limit: 1 }).map(t => t.id)).toEqual([newest.id]);
  expect(store.listTasksWhere(ctx, { states: ["queued"] }).map(t => t.id)).toEqual([next.id]);
  expect(store.listTasksWhere(ctx, { states: [] })).toEqual([]);
  expect(store.listTasksWhere(ctx, { limit: 0 })).toEqual([]);
});

test("two writer processes retain all read-modify-write updates and change tokens", async () => {
  const ctx = fakeCtx(), task = store.createTask(ctx, input);
  const before = store.taskStoreVersion(ctx);
  expect(store.taskStoreVersion(ctx)).toBe(before);
  const script = `import { updateTask } from ${JSON.stringify(new URL("../src/tasks/store.ts", import.meta.url).pathname)};
    const ctx = JSON.parse(process.argv[1]);
    for(let i=0;i<25;i++) updateTask(ctx,process.argv[2],t=>{ const n=Number(t.title??0); Bun.sleepSync(2); t.title=String(n+1); });`;
  const children = Array.from({ length: 2 }, () => Bun.spawn([process.execPath, "-e", script, JSON.stringify({ pacerHome: ctx.pacerHome, now: ctx.now }), task.id], { stdout: "pipe", stderr: "pipe" }));
  expect(await Promise.all(children.map(c => c.exited))).toEqual([0, 0]);
  expect(store.readTask(ctx, task.id)).toMatchObject({ rev: 51, title: "50" });
  expect(store.taskStoreVersion(ctx)).not.toBe(before);
  const after = store.taskStoreVersion(ctx);
  store.updateTask(ctx, task.id, t => { t.state = "done"; });
  expect(store.taskStoreVersion(ctx)).not.toBe(after);
  expect(() => store.updateTask(ctx, task.id, t => { t.title = "rollback"; throw Error("abort"); })).toThrow("abort");
  expect(store.readTask(ctx, task.id)?.title).toBe("50");
});

test("replacing a task home invalidates the cached connection and version", () => {
  const ctx = fakeCtx();
  const task = store.createTask(ctx, input), version = store.taskStoreVersion(ctx);
  rmSync(ctx.pacerHome, { recursive: true, force: true });
  expect(store.readTask(ctx, task.id)).toBeNull();
  expect(store.taskStoreVersion(ctx)).not.toBe(version);
  const next = store.createTask(ctx, input);
  expect(store.listTasks(ctx).map(t => t.id)).toEqual([next.id]);
});

test("writes remain readable by older binaries and atomic JSON updates invalidate the store token", () => {
  const ctx = fakeCtx(), task = store.createTask(ctx, input);
  const file = join(store.tasksDir(ctx), `${task.id}.json`);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(task);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  store.updateTask(ctx, task.id, t => { t.title = "new binary"; });
  const previous = JSON.parse(readFileSync(file, "utf8"));
  expect(previous).toMatchObject({ title: "new binary", rev: 2 });
  const version = store.taskStoreVersion(ctx);
  // This is the old store's temp-file + rename protocol.
  const tmp = `${file}.old.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...previous, title: "old binary", rev: 3 }));
  utimesSync(tmp, new Date(), new Date(Date.now() + 1000));
  renameSync(tmp, file);
  expect(store.taskStoreVersion(ctx)).not.toBe(version);
  expect(store.readTask(ctx, task.id)).toMatchObject({ title: "old binary", rev: 3 });
  expect(store.taskStoreVersion(ctx)).toBe(store.taskStoreVersion(ctx));
  // Same revision, newer mtime: support legacy writers that omit a rev bump.
  writeFileSync(tmp, JSON.stringify({ ...previous, title: "mtime update", rev: 3 }));
  utimesSync(tmp, new Date(), new Date(Date.now() + 2000));
  renameSync(tmp, file);
  expect(store.readTask(ctx, task.id)?.title).toBe("mtime update");
  // A missing database is rebuilt entirely from retained JSON.
  rmSync(join(ctx.pacerHome, "state/tasks.db"));
  expect(store.readTask(ctx, task.id)).toMatchObject({ title: "mtime update", rev: 3 });
});

test("unchanged directories avoid enumeration and changed directories read only changed JSON", () => {
  const ctx = fakeCtx(), first = store.createTask(ctx, input);
  store.createTask(ctx, input);
  store.taskStoreVersion(ctx); // absorb our own compatibility writes
  const scan = spyOn(fs, "readdirSync"), read = spyOn(fs, "readFileSync");
  try {
    for (let i = 0; i < 5; i++) {
      store.taskStoreVersion(ctx);
      store.listTasks(ctx);
    }
    expect(scan).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    const file = join(store.tasksDir(ctx), `${first.id}.json`);
    const tmp = `${file}.old.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...first, title: "changed", rev: 2 }));
    renameSync(tmp, file);
    expect(store.readTask(ctx, first.id)?.title).toBe("changed");
    expect(scan).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
  } finally { scan.mockRestore(); read.mockRestore(); }
});
