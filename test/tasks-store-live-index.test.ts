import { expect, spyOn, test } from "bun:test";
import { fakeCtx } from "./helpers";
import { createTask, listTasksWhere, listLiveTasks, taskDatabase, updateTask } from "../src/tasks/store";

test("live task selection uses an index instead of scanning settled history", () => {
  const ctx = fakeCtx();
  const settled = createTask(ctx, { brief: { goal: "settled", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, settled.id, t => { t.state = "done"; });
  const db = taskDatabase(ctx);
  const query = spyOn(db, "query");
  let statements: string[];
  try {
    expect(listLiveTasks(ctx)).toEqual([]);
    statements = query.mock.calls.map(args => args[0]).filter(sql => sql.startsWith("SELECT record FROM tasks"));
  } finally { query.mockRestore(); }
  expect(statements.length).toBeGreaterThan(0);
  for (const sql of statements) {
    const plan = db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[];
    // A primary-key ordering index still visits every task; only a partial index
    // excludes settled rows before their JSON is examined.
    const partial = (db.query("PRAGMA index_list(tasks)").all() as { name: string; partial: number }[])
      .filter(index => index.partial === 1).map(index => index.name);
    expect(plan.some(row => partial.some(name => row.detail.includes(`USING INDEX ${name}`)))).toBe(true);
    expect(plan.some(row => /^SCAN tasks$/.test(row.detail))).toBe(false);
  }
});


test("active state queries seek the state index instead of walking unarchived history", () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, { brief: { goal: "queued", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const db = taskDatabase(ctx);
  const query = spyOn(db, "query");
  let sql = "";
  try {
    expect(listTasksWhere(ctx, { states: ["queued", "running"] }).map(t => t.id)).toContain(task.id);
    sql = query.mock.calls.map(args => args[0]).find(sql => sql.startsWith("SELECT id FROM tasks"))!;
  } finally { query.mockRestore(); }
  const plan = db.query(`EXPLAIN QUERY PLAN ${sql}`).all("queued", "running") as { detail: string }[];
  expect(plan.some(row => /SEARCH tasks USING INDEX tasks_state .*state=/.test(row.detail))).toBe(true);
  expect(plan.some(row => row.detail.includes("TEMP B-TREE"))).toBe(false);
});
