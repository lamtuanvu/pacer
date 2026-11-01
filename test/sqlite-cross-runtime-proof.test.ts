import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { createTask, readTask, taskDatabase, updateTask, withTaskPreparation } from "../src/tasks/store";
import { dispatchDatabase } from "../src/dispatch/store";
import { messagesDatabase } from "../src/messaging/store";

const binary = process.env.PACER_SQLITE_PROOF_BIN;
const input = (repo: string) => ({ brief: { goal: "proof", repo }, kind: null, requestedExecutor: null, timeoutS: 60 });
const markProofHome = (home: string) => writeFileSync(join(home, ".sqlite-proof-home"), "disposable\n");
const rust = (command: string, home: string, id?: string) => {
  if (!binary) throw Error("PACER_SQLITE_PROOF_BIN is required");
  const result = Bun.spawnSync([binary, command, home, ...(id ? [id] : [])]);
  if (result.exitCode !== 0) throw Error(new TextDecoder().decode(result.stderr));
  return JSON.parse(new TextDecoder().decode(result.stdout));
};

test.skipIf(!binary)("Bun and Rust alternate writers, preserving schema, records and revisions", () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, input(ctx.home));
  markProofHome(ctx.pacerHome);
  dispatchDatabase(ctx);
  messagesDatabase(ctx);
  const db = taskDatabase(ctx);
  db.query("INSERT INTO work_nodes(task_id,root_id,depth,options) VALUES(?,?,?,?)").run(task.id, task.id, 0, "{}");
  db.query("INSERT INTO messages(id,root_id,sender,recipient,kind,body,status,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run("m-proof", task.id, "planner", "executor", "note", "hello", "pending", ctx.now);
  const initial = rust("snapshot", ctx.pacerHome);
  const schema = db.query<{ type: string; name: string; tbl_name: string; sql: string }, []>(
    "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  expect(initial.schema).toEqual(schema.map(r => [r.type, r.name, r.tbl_name, r.sql]));
  expect(initial.sqlite_version).toMatch(/^3\.54\./);
  expect(initial.work_nodes).toEqual([[task.id, task.id, 0, "{}"]]);
  expect(initial.messages).toEqual([["m-proof", task.id, "hello", "pending"]]);
  for (let n = 1; n <= 4; n++) {
    if (n % 2) rust("increment", ctx.pacerHome, task.id);
    else updateTask(ctx, task.id, t => { t.title = String(Number(t.title ?? 0) + 1); });
    const jsonMtime = statSync(join(ctx.pacerHome, "tasks", `${task.id}.json`)).mtimeMs;
    const dbMtime = rust("snapshot", ctx.pacerHome).tasks[0].json_mtime;
    expect(dbMtime).toBe(jsonMtime);
    expect(readTask(ctx, task.id)).toMatchObject({ rev: n + 1, title: String(n) });
    const row = rust("snapshot", ctx.pacerHome).tasks[0];
    expect(row.record).toEqual(readTask(ctx, task.id));
    expect(row.rev).toBe(n + 1);
    expect(JSON.parse(readFileSync(join(ctx.pacerHome, "tasks", `${task.id}.json`), "utf8"))).toEqual(row.record);
  }
  expect(db.query("SELECT kind FROM work_events WHERE task_id=? ORDER BY seq").all(task.id)).toHaveLength(4);
  expect(db.query("SELECT body FROM messages WHERE id='m-proof'").get()).toEqual({ body: "hello" });
  expect(statSync(join(ctx.pacerHome, "state", "tasks.db")).mode & 0o777).toBe(0o600);
});

test.skipIf(!binary)("Bun imports old JSON and reopens a replaced database after Rust observation", () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, input(ctx.home));
  markProofHome(ctx.pacerHome);
  rust("snapshot", ctx.pacerHome);
  const file = join(ctx.pacerHome, "tasks", `${task.id}.json`);
  const older = JSON.parse(readFileSync(file, "utf8"));
  updateTask(ctx, task.id, t => { t.title = "newer"; });
  const stale = { ...older, title: "stale" };
  const temp = `${file}.replacement`;
  writeFileSync(temp, JSON.stringify(stale));
  renameSync(temp, file);
  expect(readTask(ctx, task.id)).toMatchObject({ rev: 2, title: "newer" });
  const latest = { ...older, rev: 3, title: "recovered", extraProofField: { retained: true } };
  writeFileSync(temp, JSON.stringify(latest));
  renameSync(temp, file);
  expect(readTask(ctx, task.id)).toMatchObject({ rev: 3, title: "recovered", extraProofField: { retained: true } });
  expect(rust("snapshot", ctx.pacerHome).tasks[0].record).toEqual(latest);
  const other = fakeCtx();
  createTask(other, input(other.home));
  const state = join(ctx.pacerHome, "state");
  const displaced = `${state}-old`;
  renameSync(state, displaced);
  renameSync(join(other.pacerHome, "state"), state);
  mkdirSync(join(other.pacerHome, "state"));
  expect(readTask(ctx, task.id)).toMatchObject({ rev: 3, title: "recovered" });
  expect(rust("snapshot", ctx.pacerHome).tasks.some((r: { id: string }) => r.id === task.id)).toBe(true);
  new Database(join(ctx.pacerHome, "state", "tasks.db")).close();
});

test.skipIf(!binary)("Rust waits for Bun preparation while a local conflicting write fails", async () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, input(ctx.home));
  markProofHome(ctx.pacerHome);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(r => { enter = r; });
  const gate = new Promise<void>(r => { release = r; });
  const preparing = withTaskPreparation(ctx, task.id, async () => { enter(); await gate; },
    () => updateTask(ctx, task.id, t => { t.title = "0"; }));
  await entered;
  const child = Bun.spawn([binary!, "increment", ctx.pacerHome, task.id], { stdout: "pipe", stderr: "pipe" });
  expect(() => updateTask(ctx, task.id, t => { t.kind = "conflict"; })).toThrow();
  expect(readTask(ctx, task.id)?.rev).toBe(1);
  release();
  await preparing;
  expect(await child.exited).toBe(0);
  expect(readTask(ctx, task.id)).toMatchObject({ rev: 3, title: "1", kind: null });
});

test.skipIf(!binary)("Bun migrates an older task schema that Rust can inspect", () => {
  const ctx = fakeCtx();
  mkdirSync(join(ctx.pacerHome, "state"), { recursive: true });
  mkdirSync(join(ctx.pacerHome, "tasks"), { recursive: true });
  markProofHome(ctx.pacerHome);
  const db = new Database(join(ctx.pacerHome, "state", "tasks.db"));
  db.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY, rev INTEGER, state TEXT, created_at REAL, updated_at REAL, settled_at REAL, repo TEXT, record TEXT NOT NULL)");
  db.close();
  expect(readTask(ctx, "t-20261019-120000-abcd")).toBeNull();
  const names = rust("snapshot", ctx.pacerHome).schema.map((r: string[]) => r[1]);
  expect(names).toContain("tasks_retention");
  const columns = taskDatabase(ctx).query<{ name: string }, []>("PRAGMA table_info(tasks)").all().map(r => r.name);
  expect(columns).toContain("json_mtime");
  expect(columns).toContain("archived");
});
