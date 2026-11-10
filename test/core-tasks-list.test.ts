import { expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { tmpDir, fakeCtx } from "./helpers";
import { list as taskList, type ListOptions } from "../src/core/tasks";
import { visibleTaskState, type TaskState } from "../src/tasks/types";
import { listTasksWhere, readTask, newTaskId, taskSettledAt, createTask, updateTask, taskDatabase, taskArchiveDir } from "../src/tasks/store";
import { taskStatus } from "../src/tasks/api";
import { repoFor } from "../src/core/repos";
import { apiTasks } from "../src/api/read-model/tasks";
import * as repos from "../src/core/repos";
import { writeJsonAtomic } from "../src/fsutil";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
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

/** Bulk read fixtures keep the real schema/indexes/triggers, without thousands of
 * compatibility JSON writes and task locks. Selected tasks still use mkTask. */
function seedHistory(ctx: Ctx, options: { repoKey: string; executor?: string; briefRepo?: string }): void {
  const first = mkTask(ctx, 0, { ...options, state: "done" });
  // mkTask returns its pre-update record; clone the persisted terminal revision.
  const template = readTask(ctx, first.id)!;
  const db = taskDatabase(ctx);
  const insert = db.query("INSERT INTO tasks (id, rev, state, created_at, updated_at, settled_at, repo, record, archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const settle = db.query("INSERT INTO task_first_settle(task_id, at) VALUES (?, ?)");
  for (let offset = 1; offset < 1000; offset += 64) {
    db.transaction(() => {
      for (let i = offset; i < Math.min(1000, offset + 64); i++) {
        const task = structuredClone(template);
        task.id = newTaskId(ctx.now + i);
        task.createdAt = ctx.now + i;
        task.brief.goal = `Task ${i}`;
        task.brief.repo = options.briefRepo ?? (i % 2 ? B : A);
        task.repo!.path = task.brief.repo;
        // mkTask updates at ctx.now; activityAt still includes the later creation.
        insert.run(task.id, task.rev, task.state, task.createdAt, task.createdAt,
          taskSettledAt(task), task.brief.repo, JSON.stringify(task), 0);
        settle.run(task.id, task.settledAt!);
      }
    }).immediate();
  }
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
  seedHistory(ctx, { repoKey: "local:K", executor: "alice" });
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

test("states=done pages past newer running tasks", () => {
  const ctx = fakeCtx();
  // 35 newer (higher id) running tasks sit ahead of 5 older done tasks in the id-DESC
  // ordering. The page must keep walking past the active rows and return the 5 done,
  // exactly as the pre-change implementation did (a single limit+1 page would return none).
  const doneIds: string[] = [];
  for (let i = 0; i < 5; i++) { const t = mkTask(ctx, i, { state: "done" }); doneIds.push(t.id); }
  for (let i = 100; i < 135; i++) mkTask(ctx, i, { state: "running" });
  const o: ListOptions = { states: ["done"], limit: 21 };
  const got = taskList(ctx, o).map(t => t.id);
  expect(got).toHaveLength(5);
  expect(new Set(got)).toEqual(new Set(doneIds));
  expect(got).toEqual(oldList(ctx, o).map(t => t.id));
});

test("repo filter matches a task delegated from a subdirectory and a linked worktree alias", () => {
  const ctx = fakeCtx();
  const regRepo = tmpDir(), sub = join(regRepo, "pkg"), worktree = tmpDir();
  mkdirSync(sub, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeJsonAtomic(join(ctx.pacerHome, "state", "repos.json"), { [regRepo]: { path: regRepo, key: "github.com/acme/app", lastUsed: ctx.now } });
  writeJsonAtomic(join(ctx.pacerHome, "state", "repo-paths.json"), { [worktree]: regRepo });
  // No cached t.repo: repoFor(ctx, brief.repo) must resolve both the subdirectory and the
  // linked-worktree alias to the registered repo key (the old exact-match-the-root-path SQL
  // pushdown only saw <regRepo> itself and dropped these tasks).
  const subTask = mkTask(ctx, 0, { state: "done", briefRepo: sub });
  const wtTask = mkTask(ctx, 1, { state: "done", briefRepo: worktree });
  const rows = taskList(ctx, { repo: "github.com/acme/app" }).map(t => t.id);
  expect(rows).toEqual(expect.arrayContaining([subTask.id, wtTask.id]));
});
test("selective and empty history filters decode only matching records", () => {
  const ctx = fakeCtx();
  seedHistory(ctx, { repoKey: "local:bulk", executor: "bulk" });
  const selected = mkTask(ctx, -1, { state: "failed", repoKey: "local:selected", executor: "selected" });
  for (const filter of [
    { executor: "selected" }, { repo: "local:selected" }, { states: ["failed"] as TaskState[] },
    { executor: "missing" }, { repo: "missing" }, { states: ["stopped"] as TaskState[] },
    { states: [] }, { repo: "local:selected", executor: "bulk" },
  ]) {
    const monitor = countListRowsDecoded(taskDatabase(ctx));
    try {
      const rows = taskList(ctx, { ...filter, limit: 20 });
      expect(rows.map(t => t.id)).toEqual("executor" in filter && filter.executor === "selected"
        || "repo" in filter && filter.repo === "local:selected" && !("executor" in filter)
        || "states" in filter && filter.states?.[0] === "failed" ? [selected.id] : []);
      expect(monitor.count(), JSON.stringify(filter)).toBe(rows.length);
    } finally { monitor.restore(); }
  }
});

test("list filter selection uses expression indexes rather than scanning record JSON", () => {
  const ctx = fakeCtx();
  mkTask(ctx, 0, { state: "done", executor: "one", repoKey: "local:one" });
  const db = taskDatabase(ctx), original = db.query.bind(db);
  const plans: string[] = [];
  db.query = (sql: string) => {
    if (/^SELECT record FROM tasks/.test(sql)) {
      plans.push(...original(`EXPLAIN QUERY PLAN ${sql}`).all(...Array((sql.match(/\?/g) ?? []).length).fill("one"))
        .map(row => (row as { detail: string }).detail));
    }
    return original(sql);
  };
  try {
    taskList(ctx, { executor: "one" });
    taskList(ctx, { states: ["done"] });
    taskList(ctx, { repo: "local:one" });
    expect(plans.some(p => p.includes("tasks_list_executor")), plans.join("\n")).toBe(true);
    expect(plans.some(p => p.includes("tasks_list_state")), plans.join("\n")).toBe(true);
    expect(plans.some(p => p.includes("tasks_list_repo")), plans.join("\n")).toBe(true);
  } finally { db.query = original; }
});

test("mixed cached and legacy repo selection seeks both indexes before final filtering", () => {
  const ctx = fakeCtx(), root = tmpDir();
  writeJsonAtomic(join(ctx.pacerHome, "state", "repos.json"), { [root]: { path: root, key: "selected", lastUsed: ctx.now } });
  seedHistory(ctx, { repoKey: "other", briefRepo: root });
  const cached = mkTask(ctx, -2, { state: "done", repoKey: "selected", briefRepo: root });
  const legacy = mkTask(ctx, -1, { state: "done", briefRepo: join(root, "sub") });
  const db = taskDatabase(ctx), original = db.query.bind(db);
  const plans: string[][] = [];
  db.query = ((sql: string) => {
    const stmt = original(sql);
    if (!/^SELECT record FROM tasks/.test(sql)) return stmt;
    return new Proxy(stmt, {
      get(target, prop, receiver) {
        if (prop === "all") return (...args: any[]) => {
          plans.push(original(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(row => (row as { detail: string }).detail));
          return target.all(...args);
        };
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof db.query;
  try {
    expect(taskList(ctx, { repo: "selected" }).map(t => t.id)).toEqual([legacy.id, cached.id]);
    expect(taskList(ctx, { repo: "selected", limit: 1 }).map(t => t.id)).toEqual([legacy.id]);
    expect(taskList(ctx, { repo: "selected", before: legacy.id, limit: 1 }).map(t => t.id)).toEqual([cached.id]);
    expect(taskList(ctx, { repo: "selected", before: cached.id })).toEqual([]);
    expect(taskList(ctx, { repo: "selected", executor: "missing" })).toEqual([]);
    expect(plans).toHaveLength(5);
    for (const plan of plans) {
      const detail = plan.join("\n");
      expect(detail).toMatch(/SEARCH tasks USING (?:COVERING )?INDEX tasks_list_repo/);
      expect(detail).toMatch(/SEARCH tasks USING (?:COVERING )?INDEX tasks_list_legacy_repo/);
      expect(detail).not.toContain("tasks_retention");
      expect(detail).not.toMatch(/SCAN tasks\b/);
    }
  } finally { db.query = original; }
});

test("indexed filters preserve visible waiting, executor precedence and all filter combinations", () => {
  const ctx = fakeCtx();
  const root = tmpDir(), alias = tmpDir();
  writeJsonAtomic(join(ctx.pacerHome, "state", "repos.json"), { [root]: { path: root, key: "registered", lastUsed: ctx.now } });
  writeJsonAtomic(join(ctx.pacerHome, "state", "repo-paths.json"), { [alias]: root });
  const ids: string[] = [];
  for (let i = 0; i < 16; i++) {
    const task = mkTask(ctx, i, { state: i % 2 ? "running" : "done", briefRepo: join(alias, "sub"), executor: "assigned" });
    ids.push(task.id);
    updateTask(ctx, task.id, t => {
      if (i % 3 === 0) t.question = { text: "question", at: ctx.now };
      if (i % 3 === 1) t.question = { text: "question", at: ctx.now, answer: "" };
      if (i % 4 === 0) t.result = { executor: "result" } as TaskRecord["result"];
      if (i % 4 === 1) { delete t.executor; t.attempts = [{ executor: "attempt", startedAt: ctx.now, endedAt: ctx.now } as TaskRecord["attempts"][number]]; }
      if (i % 4 === 2) { delete t.executor; t.requestedExecutor = "requested"; }
      if (i % 5 === 0) t.repo = { key: "cached", label: "cached", path: root };
      if (i % 7 === 0) { mkdirSync(taskArchiveDir(ctx, t), { recursive: true }); t.archived = true; }
    });
  }
  for (const repo of [undefined, "registered", "cached", "missing"])
    for (const states of [undefined, [], ["done"], ["running"], ["needs_input"], ["done", "needs_input"]] as (TaskState[] | undefined)[])
      for (const executor of [undefined, "result", "assigned", "attempt", "requested", "missing"])
        for (const all of [false, true])
          for (const before of [undefined, ids[12]]) {
            const options = { repo, states, executor, all, before, since: ctx.now + 2, limit: 3 };
            expect(taskList(ctx, options).map(t => t.id), JSON.stringify(options)).toEqual(oldList(ctx, options).map(t => t.id));
          }
  // Registry changes must immediately affect legacy rows, without rewriting tasks.
  writeJsonAtomic(join(ctx.pacerHome, "state", "repos.json"), { [root]: { path: root, key: "renamed", lastUsed: ctx.now } });
  expect(taskList(ctx, { repo: "registered" })).toEqual([]);
  expect(taskList(ctx, { repo: "renamed" }).length).toBeGreaterThan(0);
});

test("legacy repo pages remain bounded and null answers and empty executors retain their meaning", () => {
  const ctx = fakeCtx(), root = tmpDir(), other = tmpDir();
  writeJsonAtomic(join(ctx.pacerHome, "state", "repos.json"), { [root]: { path: root, key: "selected", lastUsed: ctx.now } });
  for (let i = 0; i < 100; i++) mkTask(ctx, i, { briefRepo: other, state: "done" });
  const selected = mkTask(ctx, -1, { briefRepo: join(root, "sub"), state: "running", executor: "assigned" });
  updateTask(ctx, selected.id, t => {
    t.question = { text: "q", at: ctx.now, answer: null as unknown as string };
    t.result = { executor: "" } as TaskRecord["result"];
  });
  for (const options of [{ repo: "selected" }, { repo: "missing" }, { executor: "" }, { states: ["needs_input"] as TaskState[] }]) {
    const monitor = countListRowsDecoded(taskDatabase(ctx));
    try {
      const rows = taskList(ctx, options);
      expect(monitor.count()).toBe(rows.length);
      expect(rows.map(t => t.id)).toEqual(options.repo === "selected" || options.executor === "" ? [selected.id] : []);
    } finally { monitor.restore(); }
  }
  expect(taskList(ctx, { states: ["running"] }).map(t => t.id)).toEqual([selected.id]);
});
