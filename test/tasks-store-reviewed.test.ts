import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { createTask, hasReviewedTask, taskDatabase, updateTask } from "../src/tasks/store";
import { fakeCtx } from "./helpers";

// Frozen pre-optimization oracle: materialize every unarchived record before some().
function oldOracle(db: Database): boolean {
  return db.query<{ record: string }, []>("SELECT record FROM tasks WHERE archived=0 ORDER BY id DESC")
    .all().map(row => JSON.parse(row.record)).some(task => !!task.review);
}

// Supported writers serialize objects as canonical JSON; duplicate raw keys and
// JSON5 are outside this contract (SQLite and JSON.parse differ for those inputs).
const reviews: unknown[] = [undefined, null, false, 0, -0, "", true, 1, -1,
  Number.MIN_VALUE, -Number.MIN_VALUE, Number.MAX_VALUE, 1e-325, "0", "false", "\0", "\0tail", "a\0b", "é", [], [false], {}, { accepted: false }];

test("review existence matches the frozen JS oracle at canonical JSON boundaries", () => {
  const ctx = fakeCtx(), db = taskDatabase(ctx);
  for (const review of reviews) for (const archived of [0, 1]) {
    db.run("DELETE FROM tasks");
    const record = JSON.stringify({ id: "fixture", review, archived: !archived });
    db.run("INSERT INTO tasks(id,archived,record) VALUES(?,?,?)", ["fixture", archived, record]);
    expect(hasReviewedTask(ctx)).toBe(oldOracle(db));
    expect(hasReviewedTask(ctx)).toBe(!archived && !!JSON.parse(record).review);
  }
});

test("all task states and dismissed rows qualify; archived metadata alone excludes", () => {
  const ctx = fakeCtx(), db = taskDatabase(ctx);
  for (const state of ["queued", "running", "done", "partial", "failed", "limit", "stopped", "needs_input"]) {
    db.run("DELETE FROM tasks");
    db.run("INSERT INTO tasks(id,state,archived,record) VALUES(?,?,0,?)", ["fixture", state,
      JSON.stringify({ state, dismissed: true, archived: true, review: { accepted: false } })]);
    expect(hasReviewedTask(ctx)).toBe(true);
    db.run("UPDATE tasks SET archived=1");
    expect(hasReviewedTask(ctx)).toBe(false);
  }
});

test("existing external connection writes, same revision updates, replace, delete and rollback are visible", () => {
  const ctx = fakeCtx(), db = taskDatabase(ctx);
  const writer = new Database(join(ctx.pacerHome, "state", "tasks.db"));
  try {
    expect(hasReviewedTask(ctx)).toBe(false);
    writer.run("INSERT INTO tasks(id,rev,archived,record) VALUES('fixture',1,0,?)", [JSON.stringify({ review: false })]);
    for (const review of [{ accepted: false }, false, {}, null, []]) {
      writer.run("UPDATE tasks SET record=? WHERE id='fixture'", [JSON.stringify({ review })]);
      expect(hasReviewedTask(ctx)).toBe(oldOracle(db));
    }
    writer.run("UPDATE tasks SET archived=1");
    expect(hasReviewedTask(ctx)).toBe(false);
    writer.run("BEGIN IMMEDIATE");
    writer.run("UPDATE tasks SET archived=0");
    expect(hasReviewedTask(ctx)).toBe(false);
    writer.run("ROLLBACK");
    expect(hasReviewedTask(ctx)).toBe(false);
    writer.run("INSERT OR REPLACE INTO tasks(id,rev,archived,record) VALUES('fixture',1,0,'{\"review\":true}')");
    expect(hasReviewedTask(ctx)).toBe(true);
    writer.run("DELETE FROM tasks");
    expect(hasReviewedTask(ctx)).toBe(false);
  } finally { writer.close(); }
});

test("TypeScript writer updates are read directly without materializing task records", () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, { brief: { goal: "review", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  expect(hasReviewedTask(ctx)).toBe(false);
  updateTask(ctx, task.id, t => { t.review = { accepted: false, kind: null, note: null, at: ctx.now }; });
  const parse = spyOn(JSON, "parse");
  try {
    expect(hasReviewedTask(ctx)).toBe(true);
    expect(parse).not.toHaveBeenCalled();
  } finally { parse.mockRestore(); }
  updateTask(ctx, task.id, t => { delete t.review; });
  expect(hasReviewedTask(ctx)).toBe(false);
});

test("mixed histories find the oldest match and use the existing unarchived index", () => {
  const ctx = fakeCtx(), db = taskDatabase(ctx);
  db.transaction(() => {
    for (let i = 0; i < 100; i++) db.run("INSERT INTO tasks(id,archived,record) VALUES(?,0,?)", [
      `task-${String(i).padStart(3, "0")}`, JSON.stringify({ review: i === 0 ? {} : false, brief: { goal: "x".repeat(8192) } }),
    ]);
  })();
  const query = spyOn(db, "query");
  let sql: string;
  try {
    expect(hasReviewedTask(ctx)).toBe(oldOracle(db));
    sql = String(query.mock.calls.find(([text]: unknown[]) => String(text).startsWith("SELECT EXISTS("))![0]);
  } finally { query.mockRestore(); }
  const plan = db.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${sql}`).all();
  expect(plan.some(row => row.detail.includes("tasks_native_unarchived_id"))).toBe(true);
  db.run("UPDATE tasks SET archived=1 WHERE id='task-000'");
  expect(hasReviewedTask(ctx)).toBe(false);
});
