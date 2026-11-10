// Lane 1 (spec §3): the pump processes change-log rows plus the active set instead of
// every task; ledgers live in state/tasks.db and the cursor replays after a crash.
import { expect, test, spyOn } from "bun:test";
import { readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import type { Ctx } from "../src/types";
import { defaultPumpDeps, pumpOnce, type PumpDeps } from "../src/link/pump";
import { defaultLedgerApi, importLegacyLedgers, readCursor, readLedger } from "../src/link/ledger";
import { createTask, updateTask, taskDatabase, snapshotTaskIds, readTasksByIds } from "../src/tasks/store";
import { pruneTaskChanges, taskChangesSince } from "../src/tasks/changes";
import { updateOrcaState } from "../src/exec/orca/state";
import { writeJsonAtomic } from "../src/fsutil";
import { latestPath } from "../src/link/paths";
import { emptySnapshot, reduce, type TaskData } from "../src/link/envelope";

const status = () => ({ generatedAt: 1, strategy: "s", planner: "p", mode: "normal", disabled: false, calendarPace: false, providers: [], executors: { ranked: [], excluded: [] } }) as any;

const brief = { goal: "goal", repo: "/tmp/repo" };

function makeTask(c: Ctx, o: { state?: string; goal?: string }): string {
  const t = createTask(c, { brief: { ...brief, goal: o.goal ?? "goal" }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(c, t.id, x => { x.state = (o.state ?? "running") as never; x.attempts = []; x.result = { executor: "codex", files: "", report: "", backend: "direct" } as never; });
  return t.id;
}

function deps(c: Ctx): { d: PumpDeps; fetched: (string[] | "FULL")[]; reset(): void } {
  const fetched: (string[] | "FULL")[] = [];
  const d: PumpDeps = {
    ...defaultPumpDeps,
    status: async () => status(),
    publish: async (ctx, envs) => {
      const { readLatest } = await import("../src/link/store");
      let s = readLatest(ctx);
      for (const e of envs as never[]) s = reduce(s, e as never, ctx.now);
      writeJsonAtomic(latestPath(ctx), s);
      return { seq: s.seq + 1, transports: ["outbox"], errors: [] };
    },
    tasks: (ctx, ids) => { fetched.push(ids ? [...ids] : "FULL"); return defaultPumpDeps.tasks(ctx, ids); },
  };
  return { d, fetched, reset: () => { fetched.length = 0; } };
}

test("pump reads only changed and active tasks once caught up", async () => {
  const c = fakeCtx();
  for (let i = 0; i < 200; i++) makeTask(c, { state: "done", goal: `g${i}` });
  const a1 = makeTask(c, {}), a2 = makeTask(c, {});
  const { d, fetched, reset } = deps(c);
  await pumpOnce(c, d); // first pump: full reconcile and cursor write
  reset();
  expect(await pumpOnce(c, d)).toEqual([]);
  // One selection fetch holding exactly the two active task ids:
  expect(fetched.length).toBe(1);
  expect(fetched[0]).not.toBe("FULL");
  expect([...new Set(fetched[0] as string[])].sort()).toEqual([a1, a2].sort());
});

test("a settled task that changes is published on the next pump", async () => {
  const c = fakeCtx();
  const t = makeTask(c, { state: "done", goal: "first" });
  const { d, fetched, reset } = deps(c);
  await pumpOnce(c, d);
  reset();
  updateTask(c, t, x => { x.title = "renamed"; });
  const out = await pumpOnce(c, d);
  expect(out.filter(e => e.type === "task")).toHaveLength(1);
  expect(out.find(e => e.type === "task")).toMatchObject({ data: { id: t, title: "renamed" } });
  expect(fetched).toEqual([[t]]); // the changed settled task, nothing else
  reset();
  expect((await pumpOnce(c, d)).filter(e => e.type === "task")).toHaveLength(0);
  reset();
});

test("a cursor gap triggers one full reconcile", async () => {
  const c = fakeCtx();
  const settledIds = Array.from({ length: 5 }, (_, i) => makeTask(c, { state: "done", goal: `g${i}` }));
  const settledId = settledIds[0]!;
  const { d, fetched, reset } = deps(c);
  await pumpOnce(c, d); // cursor at head
  const first = makeTask(c, { state: "done" });
  const second = makeTask(c, { state: "done" });
  pruneTaskChanges(c, { keepRows: 1 }); // everything below the newest row: gap
  reset();
  // The full pass covers every task once; the pruned new tasks get their first publish here.
  const out2 = await pumpOnce(c, d);
  expect(out2.filter(e => e.type === "task").map(e => (e.data as { id: string }).id).sort()).toEqual([first, second].sort());
  // The cover is paged through the store, not one unbounded fetch.
  expect(fetched.every(p => p !== "FULL")).toBe(true);
  expect([...new Set(fetched.flat() as string[])].sort()).toEqual([...settledIds, first, second].sort());
  reset();
  // update one settled task and confirm the pump returns to incremental processing
  updateTask(c, settledId, x => { x.title = "again"; });
  const out = await pumpOnce(c, d);
  expect(out.filter(e => e.type === "task")).toHaveLength(1);
  expect(out.find(e => e.type === "task")).toMatchObject({ data: { id: settledId, title: "again" } });
  expect(fetched).toEqual([[settledId]]);
});

test("legacy JSON ledgers are imported once and left in place", async () => {
  const c = fakeCtx();
  const t = makeTask(c, { state: "done", goal: "legacy" });
  const dataPath = join(c.pacerHome, "link", "task-data-seen.json");
  const statesPath = join(c.pacerHome, "link", "task-states.json");
  const timesPath = join(c.pacerHome, "link", "task-events-at.json");
  const legacy: Record<string, TaskData> = { [t]: { id: t, title: "legacy", state: "done", goal: "legacy", executor: "codex", backend: "direct", worktree: null, updatedAt: 5 } as TaskData };
  writeJsonAtomic(dataPath, legacy);
  writeJsonAtomic(statesPath, { [t]: "done" });
  writeJsonAtomic(timesPath, { [t]: 123 });
  importLegacyLedgers(c);
  const ledged = readLedger(c, [t]);
  expect(ledged.get(t)).toMatchObject({ state: "done", eventAt: 123 });
  expect(ledged.get(t)?.data).toEqual(legacy[t]);
  // A second import must not read the files again: the tables are no longer empty.
  writeJsonAtomic(statesPath, { [t]: "running" });
  expect(readLedger(c, [t]).get(t)).toMatchObject({ state: "done", eventAt: 123 });
  expect(readFileSync(dataPath, "utf8")).toContain(`"${t}"`);
  expect(JSON.parse(readFileSync(statesPath, "utf8"))).toEqual({ [t]: "running" });
  expect(readCursor(c)).toBeNull();
});

test("a settled task keeps an orca terminal in the active set until the terminal is gone", async () => {
  const c = fakeCtx();
  const t = makeTask(c, { state: "done", goal: "settled with terminal" });
  updateTask(c, t, x => { x.backend = "orca"; });
  updateOrcaState(c, state => { state.workers.d = { dispatchId: "d", taskId: t, terminal: "term_worker", executor: "codex", worktree: null, startedAt: c.now }; });
  const { d, fetched, reset } = deps(c);
  await pumpOnce(c, d); // full pass: the terminal-bearing task publishes and joins the session registry
  reset();
  updateOrcaState(c, state => { delete state.workers.d; }); // no task row changes
  await pumpOnce(c, d); // still processed: the pump observed the terminal is gone
  expect(fetched.length).toBe(1);
  expect(fetched[0]).not.toBe("FULL");
  expect([...new Set(fetched[0] as string[])].sort()).toEqual([t]);
  reset();
  await pumpOnce(c, d); // the registry dropped it; nothing selects it now
  expect(fetched).toEqual([[]]);
});

test("a crash before the cursor write replays the changes", async () => {
  const c = fakeCtx();
  const a1 = makeTask(c, {}), a2 = makeTask(c, {});
  const { d, fetched, reset } = deps(c);
  const sessions: [string[], string[]][] = []; // sampled by writeSessions
  const brokenCursor = { ...defaultLedgerApi, writeCursor: () => { throw new Error("disk full"); },
    writeSessions: (ctx: Ctx, keep: string[], drop: string[]) => { sessions.push([keep, drop]); } };
  await expect(pumpOnce(c, d, { ledger: brokenCursor })).rejects.toThrow("disk full");
  expect(readCursor(c)).toBeNull(); // publish succeeded, the cursor write did not
  expect(readLedger(c, [a1, a2]).size).toBe(2); // ledgers already recorded the published data
  expect(sessions).toEqual([]); // registry bookkeeping runs after the cursor write: a failed cursor leaves it untouched
  reset();
  expect(await pumpOnce(c, d)).toEqual([]); // re-emits nothing duplicated
  expect(fetched.length).toBe(1);
  expect(fetched[0]).not.toBe("FULL");
  expect([...new Set(fetched[0] as string[])].sort()).toEqual([a1, a2].sort()); // and does not skip them
});

test("a settled builtin task stays in the active set only while its session is live", async () => {
  const c = fakeCtx();
  const t = makeTask(c, { state: "done", goal: "live builtin session" });
  const dir = join(c.pacerHome, "runs", t, "1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.log"), "");
  writeFileSync(join(dir, "pid"), String(process.pid));
  writeFileSync(join(dir, "session.sock"), ""); // sessionSocket's default name for a dir without session.sock.path
  const { d, fetched, reset } = deps(c);
  await pumpOnce(c, d); // reconcile: the live builtin session publishes and joins the registry
  reset();
  await pumpOnce({ ...c, now: c.now + 2 }, d); // still selected through the registry, nothing changed
  expect(fetched.length).toBe(1);
  expect(fetched[0]).not.toBe("FULL");
  expect([...new Set(fetched[0] as string[])]).toEqual([t]);
  reset();
  rmSync(join(dir, "session.sock")); // the session goes live->dead without any tasks-row change
  const out = await pumpOnce({ ...c, now: c.now + 4 }, d);
  expect(out.filter(e => e.type === "task")).toHaveLength(1);
  expect(out.find(e => e.type === "task")).toMatchObject({ data: { id: t, session: { host: "builtin", live: false } } });
  reset();
  await pumpOnce({ ...c, now: c.now + 6 }, d); // the registry dropped it; nothing selects it now
  expect(fetched).toEqual([[]]);
});

test("the registry keeps only live agent sessions and drops deleted tasks", async () => {
  const c = fakeCtx();
  const live = makeTask(c, { state: "done" }), gone = makeTask(c, { state: "done" });
  const db = taskDatabase(c);
  // What the agent-session service creates on first use (src/session/agents.ts).
  db.query("CREATE TABLE IF NOT EXISTS agent_sessions (id TEXT PRIMARY KEY, task TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, record TEXT NOT NULL)").run();
  db.query("CREATE TABLE IF NOT EXISTS agent_session_revision(id INTEGER PRIMARY KEY CHECK(id=1),generation INTEGER NOT NULL)").run();
  db.query("INSERT OR IGNORE INTO agent_session_revision VALUES(1,0)").run();
  const insert = db.query("INSERT INTO agent_sessions(id,task,request_id,payload,record) VALUES(?,?,?,?,?)");
  const session = (id: string, task: string, state: string) =>
    JSON.stringify({ id, task_id: task, attempt: 1, state, attempts: [] });
  insert.run("s1", live, "req-1", "{}", session("s1", live, "starting"));
  insert.run("s2", gone, "req-2", "{}", session("s2", gone, "ended"));
  db.query("INSERT INTO pump_session(task_id) VALUES(?)").run("t-20261110-120000-dead"); // a deleted task's stale entry
  expect(defaultLedgerApi.registryTaskIds(c)).toEqual([live]); // the ended session is not live
  expect(taskDatabase(c).query<{ count: number }, []>("SELECT COUNT(*) AS count FROM pump_session").get()!.count).toBe(0);
  expect(defaultLedgerApi.registryTaskIds(c)).toEqual([live]); // and the cleanup is stable
});

test("a full reconcile wakes every ten minutes to cover same-revision JSON imports", async () => {
  const c = fakeCtx();
  const t = makeTask(c, { state: "done", goal: "first" });
  const { d, fetched, reset } = deps(c);
  await pumpOnce(c, d); // first pass: reconcile and cadence schedule
  reset();
  // An older binary rewrites only the JSON and re-imports the same rev: no task_changes row.
  const row = taskDatabase(c).query<{ record: string }, [string]>("SELECT record FROM tasks WHERE id = ?").get(t)!;
  taskDatabase(c).query("UPDATE tasks SET record = ? WHERE id = ?")
    .run(JSON.stringify({ ...JSON.parse(row.record), title: "changed outside the log" }), t);
  // Five minutes in: only a strategy pass runs — quiet, and the change is not yet walked.
  expect(await pumpOnce({ ...c, now: c.now + 301 }, d)).toEqual([]);
  expect(fetched.every(p => p !== "FULL")).toBe(true); // passes read pages, too
  reset();
  // Ten minutes: the reconcile diff-walks the record change and publishes it.
  const out = await pumpOnce({ ...c, now: c.now + 601 }, d);
  expect(out.filter(e => e.type === "task")).toHaveLength(1);
  expect(out.find(e => e.type === "task")).toMatchObject({ data: { id: t, title: "changed outside the log" } });
  reset();
  // The cadence restarted: the following pass is quiet.
  expect((await pumpOnce({ ...c, now: c.now + 602 }, d)).filter(e => e.type === "task")).toHaveLength(0);
});

test("a full reconcile pages through tasks instead of one unbounded fetch", async () => {
  const c = fakeCtx();
  const ids = Array.from({ length: 250 }, () => makeTask(c, { state: "done" }));
  const { d, fetched } = deps(c);
  const out = await pumpOnce(c, d);
  expect(out.filter(e => e.type === "task")).toHaveLength(250); // every task walked and published
  expect(fetched.every(p => p !== "FULL")).toBe(true);
  expect(fetched.length).toBe(2); // 200 + 50: two bounded pages
  expect(new Set(fetched.flat() as string[])).toEqual(new Set(ids));
});

test("the legacy JSON ledgers keep mirroring the SQLite ledgers", async () => {
  const c = fakeCtx();
  const t = makeTask(c, {}); // running
  const { d, reset } = deps(c);
  await pumpOnce(c, d); // reconcile pass: the mirror is rebuilt from the SQLite tables
  const statesPath = join(c.pacerHome, "link", "task-states.json");
  const dataPath = join(c.pacerHome, "link", "task-data-seen.json");
  const timesPath = join(c.pacerHome, "link", "task-events-at.json");
  expect(JSON.parse(readFileSync(statesPath, "utf8"))[t]).toBe("running");
  expect(typeof JSON.parse(readFileSync(timesPath, "utf8"))[t]).toBe("number");
  expect(JSON.parse(readFileSync(dataPath, "utf8"))[t]).toMatchObject({ id: t, state: "running" });
  reset();
  updateTask(c, t, x => { x.state = "done"; });
  await pumpOnce({ ...c, now: c.now + 2 }, d); // a settle: the mirror follows without waiting for the cadence
  expect(JSON.parse(readFileSync(statesPath, "utf8"))[t]).toBe("done");
  expect(JSON.parse(readFileSync(dataPath, "utf8"))[t]).toMatchObject({ state: "done" });
  reset();
  // A quiet tick must not rewrite the whole files again: an older binary's sentinel survives.
  writeJsonAtomic(timesPath, { stale: 1 });
  expect(await pumpOnce({ ...c, now: c.now + 4 }, d)).toEqual([]);
  expect(JSON.parse(readFileSync(timesPath, "utf8"))).toEqual({ stale: 1 });
});

test("more than one page of pending changes catches up with one reconcile", async () => {
  const c = fakeCtx();
  const t1 = makeTask(c, { state: "done" }), t2 = makeTask(c, { state: "done" });
  const { d, fetched, reset } = deps(c);
  await pumpOnce(c, d);
  reset();
  const db = taskDatabase(c);
  for (let i = 0; i < 600; i++) db.query("INSERT INTO task_changes(task_id,rev,state,at) VALUES(?,?,?,?)")
    .run(`t-20261110-120000-${String(i).padStart(4, "0")}`, 1, "done", c.now); // 600 unseen rows: a page and a half
  await pumpOnce(c, d);
  // One bounded cover of the real tasks instead of a 500-row crawl.
  expect(fetched.every(p => p !== "FULL" && p.length <= 200)).toBe(true);
  expect(new Set(fetched.flat() as string[])).toEqual(new Set([t1, t2]));
  reset();
  const after = taskChangesSince(c, readCursor(c) ?? -1);
  expect(after.gap).toBe(false); // the log was consumed to its head, not left half-drained
  expect(after.changes).toHaveLength(0);
  reset();
  await pumpOnce({ ...c, now: c.now + 1 }, d);
  expect(fetched).toEqual([[]]); // and the next tick returns to the incremental routine
});

test("a 15 s pass on a 2,000-task home decodes no more than the active set plus the snapshot window", async () => {
  const c = fakeCtx();
  for (let i = 0; i < 2000; i++) makeTask(c, { state: "done" });
  const { d } = deps(c);
  await pumpOnce(c, d);
  const parse = JSON.parse;
  let decoded = 0;
  JSON.parse = ((value: string, ...args: any[]) => {
    const result = parse(value, ...args);
    if (result?.brief && result?.id && Array.isArray(result?.attempts)) decoded++;
    return result;
  }) as typeof JSON.parse;
  try {
    await pumpOnce({ ...c, now: c.now + 16 }, d);
  } finally {
    JSON.parse = parse;
  }
  expect(decoded).toBe(200);
});


test("snapshot IDs retain recent undismissed tasks ordered by event time", () => {
  const c = fakeCtx();
  const old = { ...c, now: c.now - 90000 };
  const settled = makeTask(old, { state: "done" });
  const active = makeTask(old, {});
  const recent = makeTask(c, { state: "done" });
  const dismissed = makeTask(c, { state: "done" });
  updateTask(c, dismissed, t => { t.dismissed = true; });
  expect(new Set(snapshotTaskIds(c))).toEqual(new Set([recent]));
  updateTask(c, settled, t => { t.question = { at: c.now + 1 } as never; });
  expect(snapshotTaskIds(c)[0]).toBe(settled);
  expect(readTasksByIds(c, snapshotTaskIds(c))).toHaveLength(2);
});


test("periodic fetch unions changed and active IDs with at most 200 snapshot IDs", async () => {
  const c = fakeCtx();
  for (let i = 0; i < 205; i++) makeTask(c, { state: "done" });
  const old = { ...c, now: c.now - 90000 };
  const active = makeTask(old, {});
  const changed = makeTask(old, { state: "done" });
  const { d, fetched, reset } = deps(c);
  await pumpOnce(c, d);
  updateTask(c, changed, t => { t.title = "changed"; });
  reset();
  await pumpOnce({ ...c, now: c.now + 16 }, d);
  expect(fetched).toHaveLength(1);
  const ids = fetched[0] as string[];
  expect(ids).toContain(active);
  expect(ids).toContain(changed);
  expect(ids.length).toBeLessThanOrEqual(202);
});


test("snapshot selection seeks its timestamp index without a history scan or sort", () => {
  const c = fakeCtx();
  makeTask(c, { state: "done" });
  const db = taskDatabase(c);
  const query = db.query.bind(db);
  let selection = "";
  const spy = spyOn(db, "query").mockImplementation(((sql: string, ...args: any[]) => {
    if (sql.includes("SELECT id FROM tasks INDEXED BY tasks_snapshot_window")) selection = sql;
    return (query as any)(sql, ...args);
  }) as typeof db.query);
  try { expect(snapshotTaskIds(c)).toHaveLength(1); }
  finally { spy.mockRestore(); }
  expect(selection).not.toBe("");
  const plan = db.query<{ detail: string }, [number]>(`EXPLAIN QUERY PLAN ${selection}`).all(c.now - 86400);
  expect(plan.map(row => row.detail).join("\n")).toContain("SEARCH tasks USING INDEX tasks_snapshot_window");
  expect(plan.some(row => row.detail.includes("TEMP B-TREE"))).toBe(false);
});
