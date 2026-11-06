import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTask, listTasks, readTask, updateTask } from "../src/tasks/store";
import { fakeCtx } from "./helpers";

function lookups(query: ReturnType<typeof spyOn>): number {
  return query.mock.calls.filter(([sql]) => /json_mtime FROM tasks WHERE id = \?/.test(String(sql))).length;
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
    expect(readTask(ctx, tasks[0]!.id)?.title).toBe("external");
    expect(readTask(ctx, tasks[1]!.id)?.title).toBe("own write");
    expect(lookups(query)).toBe(1);
  } finally { query.mockRestore(); }
});
