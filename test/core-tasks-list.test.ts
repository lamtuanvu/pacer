import { expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { tmpDir, fakeCtx } from "./helpers";
import { list as taskList, type ListOptions } from "../src/core/tasks";
import { visibleTaskState, type TaskState } from "../src/tasks/types";
import { listTasksWhere, createTask, updateTask, taskDatabase } from "../src/tasks/store";
import { taskStatus } from "../src/tasks/api";
import { repoFor } from "../src/core/repos";
import { apiTasks } from "../src/api/read-model/tasks";
import * as repos from "../src/core/repos";
import type { Ctx } from "../src/types";
import type { TaskRecord } from "../src/tasks/types";

const A = tmpDir(), B = tmpDir();

function mkTask(ctx: Ctx, i: number, o: { state?: TaskState; repoKey?: string; executor?: string; briefRepo?: string; setRepo?: boolean }): TaskRecord {
  const task = createTask({ ...ctx, now: ctx.now + i }, {
    brief: { goal: `Task ${i}`, repo: o.briefRepo ?? (i % 2 ? B : A) }, kind: null, requestedExecutor: o.executor ?? null, timeoutS: 60,
  });
  updateTask(ctx, task.id, t => {
    t.state = o.state ?? (i % 3 === 0 ? "failed" : "done");
    if (o.executor !== undefined) t.executor = o.executor;
    if (o.repoKey !== undefined && o.setRepo !== false) t.repo = { key: o.repoKey, path: o.briefRepo ?? (i % 2 ? B : A), label: "l" };
  });
  return task;
}

/** The pre-change core.tasks.list semantics, replayed in JS over the full matching set,
 *  used as the golden for the SQL-pushdown implementation. */
function oldList(ctx: Ctx, o: ListOptions): TaskRecord[] {
  const states = o.states ? [...new Set<TaskState>([...o.states, "queued", "running"])] : undefined;
  return listTasksWhere(ctx, { updatedSince: o.since, states, all: o.all })
    .filter(t => o.before === undefined || t.id < o.before)
    .map(t => taskStatus(ctx, t.id) ?? t)
    .filter(t => (o.repo === undefined || (t.repo ?? repoFor(ctx, t.brief.repo)).key === o.repo)
      && (o.states === undefined || o.states.includes(visibleTaskState(t)))
      && (o.executor === undefined || (t.result?.executor ?? t.executor ?? t.attempts.at(-1)?.executor ?? t.requestedExecutor) === o.executor)
      && (o.since === undefined || t.createdAt >= o.since))
    .slice(0, o.limit ?? 20);
}

function countListRowsDecoded(db: Database): { count: () => number; restore: () => void } {
  const orig = db.query.bind(db);
  let decoded = 0;
  // @ts-expect-error monkeypatch
  db.query = (sql: string) => {
    const stmt = orig(sql);
    if (!/SELECT record FROM tasks\b/.test(sql) || !/ORDER BY id DESC/.test(sql)) return stmt;
    return new Proxy(stmt, {
      get(target, prop, recv) {
        if (prop === "all") return (...args: unknown[]) => { const rows = (target as any).all(...(args as any)); decoded += rows.length; return rows; };
        const v = Reflect.get(target, prop, recv);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  };
  return { count: () => decoded, restore: () => { db.query = orig; } };
}

test("task.list pages history in SQL without loading every row", () => {
  const ctx = fakeCtx();
  for (let i = 0; i < 1000; i++) mkTask(ctx, i, { state: "done", repoKey: "local:K", executor: "alice" });
  const db = taskDatabase(ctx);
  const monitor = countListRowsDecoded(db);
  try {
    const rows = taskList(ctx, { limit: 20 });
    expect(rows).toHaveLength(20);
    expect(monitor.count()).toBeLessThanOrEqual(21);
  } finally {
    monitor.restore();
  }
});

test("task.list filters by repo, states, executor and before exactly as before", () => {
  const ctx = fakeCtx();
  const ids: string[] = [];
  for (let i = 0; i < 12; i++) {
    const t = mkTask(ctx, i, {
      state: i % 4 === 0 ? "failed" : "done",
      repoKey: i % 2 ? "local:B" : "local:A",
      executor: i % 3 === 0 ? "bob" : "alice",
      briefRepo: i % 2 ? B : A,
    });
    ids.push(t.id);
  }
  const params: ListOptions[] = [
    {},
    { limit: 5 },
    { states: ["done"] },
    { states: ["done", "failed"] },
    { repo: "local:A" },
    { repo: "local:B", states: ["done"] },
    { executor: "bob" },
    { executor: "alice", states: ["done"] },
    { repo: "local:A", executor: "alice", states: ["done"] },
    { before: ids[8], limit: 4 },
    { repo: "local:B", before: ids[6], limit: 3 },
    { since: ctx.now + 6 },
    { states: ["done"], limit: 6 },
  ];
  for (const o of params) {
    const got = taskList(ctx, o).map(t => t.id);
    const want = oldList(ctx, o).map(t => t.id);
    expect(got, JSON.stringify(o)).toEqual(want);
  }
});

test("apiTasks reads the repo registry once per call", () => {
  const ctx = fakeCtx();
  for (let i = 0; i < 8; i++) mkTask(ctx, i, { state: "done", repoKey: i % 2 ? "local:B" : "local:A", executor: "alice", briefRepo: i % 2 ? B : A });
  const all = listTasksWhere(ctx, { limit: 100 });
  const readOnce = spyOn(repos, "listRepos");
  try {
    const out = apiTasks(ctx, all);
    expect(out).toHaveLength(8);
    expect(readOnce).toHaveBeenCalledTimes(1);
  } finally { readOnce.mockRestore(); }
});