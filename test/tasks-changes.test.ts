import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { createTask, readTask, taskDatabase, updateTask } from "../src/tasks/store";
import { pruneTaskChanges, taskChangesHead, taskChangesSince } from "../src/tasks/changes";

const brief = { goal: "Fix the bug", repo: "/tmp/repo" };

test("createTask logs one change", () => {
  const ctx = fakeCtx();
  const t = createTask(ctx, { brief, kind: null, requestedExecutor: null, timeoutS: 60 });
  const { changes } = taskChangesSince(ctx, 0);
  expect(changes).toHaveLength(1);
  expect(changes[0]).toMatchObject({ taskId: t.id, rev: t.rev, state: t.state });
});

test("real update logs, no-op and bookkeeping updates do not", () => {
  const ctx = fakeCtx();
  const t = createTask(ctx, { brief, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, t.id, x => { x.title = "q"; }); // real change: logs
  updateTask(ctx, t.id, x => { x.title = "q"; }); // no-op: does not log
  taskDatabase(ctx).query("UPDATE tasks SET json_mtime = json_mtime + 1 WHERE id = ?").run(t.id); // bookkeeping: does not log
  const { changes } = taskChangesSince(ctx, 0);
  expect(changes).toHaveLength(2);
});

test("a writer that knows nothing about the log is still logged", () => {
  const ctx = fakeCtx();
  const t = createTask(ctx, { brief, kind: null, requestedExecutor: null, timeoutS: 60 });
  const headBefore = taskChangesHead(ctx);
  const path = join(ctx.pacerHome, "state", "tasks.db");
  const db = new Database(path);
  try {
    db.query("INSERT INTO tasks (id, rev, state, created_at, updated_at, settled_at, repo, record, archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("t-20261101-120000-feed", 1, "queued", ctx.now, ctx.now, null, "/tmp/repo", JSON.stringify({ id: "t-20261101-120000-feed", rev: 1, state: "queued" }), 0);
    db.query("UPDATE tasks SET rev = rev + 1 WHERE id = ?").run(t.id);
  } finally { db.close(); }
  const { changes } = taskChangesSince(ctx, headBefore);
  expect(changes).toHaveLength(2);
  expect(changes.map(c => c.taskId).sort()).toEqual(["t-20261101-120000-feed", t.id].sort());
});

test("gap after prune", () => {
  const ctx = fakeCtx();
  createTask(ctx, { brief, kind: null, requestedExecutor: null, timeoutS: 60 });
  createTask({ ...ctx, now: ctx.now + 1 }, { brief, kind: null, requestedExecutor: null, timeoutS: 60 });
  createTask({ ...ctx, now: ctx.now + 2 }, { brief, kind: null, requestedExecutor: null, timeoutS: 60 });
  const head = taskChangesHead(ctx);
  const pruned = pruneTaskChanges(ctx, { keepRows: 1 });
  expect(pruned).toBe(2);
  expect(taskChangesSince(ctx, 0).gap).toBe(true);
  const after = taskChangesSince(ctx, head - 1);
  expect(after.gap).toBe(false);
  expect(after.changes).toHaveLength(1);
});

test("existing database without the log gets it on open", () => {
  const ctx = fakeCtx();
  const path = join(ctx.pacerHome, "state", "tasks.db");
  mkdirSync(join(ctx.pacerHome, "state"), { recursive: true });
  const legacy = new Database(path);
  legacy.run(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, rev INTEGER, state TEXT, created_at REAL,
    updated_at REAL, settled_at REAL NULL, repo TEXT NULL, record TEXT NOT NULL, json_mtime REAL, archived INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX tasks_state ON tasks(state);
  CREATE INDEX tasks_updated_at ON tasks(updated_at);
  CREATE INDEX tasks_created_at ON tasks(created_at);
  CREATE INDEX tasks_retention ON tasks(archived, settled_at);
  CREATE TABLE task_first_settle(task_id TEXT PRIMARY KEY, at REAL NOT NULL);`);
  const existing = { id: "t-20261101-130000-dead", rev: 3, state: "done", createdAt: ctx.now, updatedAt: ctx.now, repo: "/tmp/repo" };
  legacy.query("INSERT INTO tasks (id, rev, state, created_at, updated_at, settled_at, repo, record, json_mtime, archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(existing.id, existing.rev, existing.state, existing.createdAt, existing.updatedAt, existing.createdAt, existing.repo, JSON.stringify(existing), 1234, 0);
  legacy.close();

  const before = readTask(ctx, existing.id);

  const objects = taskDatabase(ctx).query<{ name: string; type: string }, []>(
    "SELECT name, type FROM sqlite_master WHERE name IN ('task_changes', 'task_changes_insert', 'task_changes_update')").all();
  expect(objects.map(o => o.name).sort()).toEqual(["task_changes", "task_changes_insert", "task_changes_update"]);

  const after = readTask(ctx, existing.id);
  expect(after?.rev).toBe(before?.rev);
  expect(after).toEqual(before);
  const row = taskDatabase(ctx).query<{ json_mtime: number }, [string]>("SELECT json_mtime FROM tasks WHERE id = ?").get(existing.id);
  expect(row?.json_mtime).toBe(1234);
});
