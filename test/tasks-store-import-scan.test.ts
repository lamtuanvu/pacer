import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTask, listTasksWhere, listTasks, newTaskId, readTask, reconcileTaskJson, tasksDir, taskJsonScanCount, updateTask } from "../src/tasks/store";
import { fakeCtx } from "./helpers";

const brief = { goal: "Fix the bug", repo: "/tmp/repo", acceptance: "bun test" };

function lookups(query: ReturnType<typeof spyOn>): number {
  return query.mock.calls.filter(([sql]: unknown[]) => /json_mtime FROM tasks WHERE id = \?/.test(String(sql))).length;
}

test("a task directory change looks up only the JSON files that changed since the last scan", () => {
  const ctx = fakeCtx();
  const tasks = Array.from({ length: 40 }, (_, i) => createTask(ctx, { brief: { goal: `goal ${i}`, repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 }));
  updateTask(ctx, tasks[1]!.id, t => { t.title = "own write"; });
  const query = spyOn(Database.prototype, "query");
  try {
    expect(listTasks(ctx, Infinity)).toHaveLength(40);
    expect(lookups(query)).toBe(0);
    // Another process replaces one compatibility file with a newer revision.
    const file = join(ctx.pacerHome, "tasks", `${tasks[0]!.id}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify({ ...readTask(ctx, tasks[0]!.id)!, rev: 99, title: "external" }));
    renameSync(`${file}.tmp`, file);
    query.mockClear();
    // Reads on the cached connection no longer rescan the directory on their own;
    // an explicit reconcile (the Worker's periodic cadence) is what sees the change.
    expect(reconcileTaskJson(ctx)).toBe(1);
    expect(readTask(ctx, tasks[0]!.id)?.title).toBe("external");
    expect(readTask(ctx, tasks[1]!.id)?.title).toBe("own write");
    expect(lookups(query)).toBe(1);
  } finally { query.mockRestore(); }
});

test("own writes do not trigger a folder rescan on the cached connection", () => {
  const ctx = fakeCtx();
  const t = createTask(ctx, { brief, kind: null, requestedExecutor: null, timeoutS: 60 });
  const scans = taskJsonScanCount();
  for (let i = 0; i < 5; i++) { updateTask(ctx, t.id, x => { x.title = `q${i}`; }); listTasksWhere(ctx, {}); }
  expect(taskJsonScanCount()).toBe(scans);
});

test("reconcileTaskJson imports a newer JSON-only revision", () => {
  const ctx = fakeCtx();
  const t = createTask(ctx, { brief, kind: null, requestedExecutor: null, timeoutS: 60 });
  writeFileSync(join(tasksDir(ctx), `${t.id}.json`), JSON.stringify({ ...t, rev: t.rev + 5, title: "from old binary" }));
  // List reads never import (a single-task read does; see the readTask test below).
  expect(listTasks(ctx).find(x => x.id === t.id)!.title).toBeUndefined();
  expect(reconcileTaskJson(ctx)).toBe(1);
  expect(listTasks(ctx).find(x => x.id === t.id)!.title).toBe("from old binary");
});

test("a fresh connection imports on open after the home's tasks.db is replaced", () => {
  const ctx = fakeCtx();
  const t = createTask(ctx, { brief, kind: null, requestedExecutor: null, timeoutS: 60 });
  // Hold a cached connection open (readTask opens/caches it for this pacerHome).
  expect(readTask(ctx, t.id)?.id).toBe(t.id);

  // Simulate the home being replaced/restored while this process still holds a
  // connection: swap tasks.db for a brand-new (empty) file, which gets a new inode.
  const dbPath = join(ctx.pacerHome, "state", "tasks.db");
  const freshPath = `${dbPath}.fresh`;
  writeFileSync(freshPath, "");
  renameSync(freshPath, dbPath);

  // An older binary (or the restore itself) leaves a JSON-only task behind; nothing
  // in the new, empty database knows about it yet.
  const extraId = newTaskId(ctx.now + 1);
  const extra = { ...t, id: extraId, rev: 1, title: "fresh" };
  writeFileSync(join(tasksDir(ctx), `${extraId}.json`), JSON.stringify(extra));

  // The next access reopens on the inode change and imports on that new handle,
  // with no explicit reconcile call.
  expect(readTask(ctx, extraId)?.title).toBe("fresh");
});

test("readTask picks up a newer JSON revision of that one task without a folder scan", () => {
  const ctx = fakeCtx();
  const t = createTask(ctx, { brief, kind: "debug", requestedExecutor: null, timeoutS: 1800 });
  listTasks(ctx);
  const scans = taskJsonScanCount();
  // An older binary or a write that crashed before its SQLite commit leaves a newer JSON copy.
  const temp = join(tasksDir(ctx), `${t.id}.json.tmp`);
  writeFileSync(temp, JSON.stringify({ ...t, rev: t.rev + 4, question: { text: "from JSON", at: 0 } }));
  renameSync(temp, join(tasksDir(ctx), `${t.id}.json`));
  expect(readTask(ctx, t.id)!.rev).toBe(t.rev + 4);
  expect(readTask(ctx, t.id)!.question?.text).toBe("from JSON");
  expect(taskJsonScanCount()).toBe(scans);
});
