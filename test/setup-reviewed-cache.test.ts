import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkSetup } from "../src/setup/check";
import { createTask, reconcileTaskJson, taskDatabase } from "../src/tasks/store";
import type { Ctx } from "../src/types";
import { fakeCtx } from "./helpers";

async function first(ctx: Ctx) {
  return (await checkSetup(ctx, { snapshotProbe: false, deferStatus: true })).items.find(i => i.id === "first")!.status;
}
function queryCount(query: ReturnType<typeof spyOn>) {
  return query.mock.calls.filter(([sql]: unknown[]) => String(sql).startsWith("SELECT EXISTS(")).length;
}

for (const external of [false, true]) test(`negative cache invalidates on ${external ? "external" : "local"} same-revision writes`, async () => {
  const ctx = fakeCtx(), db = taskDatabase(ctx);
  const writer = external ? new Database(join(ctx.pacerHome, "state", "tasks.db")) : db;
  const query = spyOn(db, "query");
  try {
    expect(await first(ctx)).not.toBe("done");
    expect(await first(ctx)).not.toBe("done");
    expect(queryCount(query)).toBe(1);
    writer.run("INSERT INTO tasks(id,rev,archived,record) VALUES('fixture',1,0,'{\"review\":false}')");
    expect(await first(ctx)).not.toBe("done");
    expect(await first(ctx)).not.toBe("done");
    expect(queryCount(query)).toBe(2);
    writer.run("UPDATE tasks SET record='{\"review\":{\"accepted\":false}}'");
    expect(await first(ctx)).toBe("done");
    expect(queryCount(query)).toBe(3);
    writer.run("UPDATE tasks SET archived=1");
    expect(await first(ctx)).toBe("done");
    writer.run("DELETE FROM tasks");
    expect(await first(ctx)).toBe("done");
    expect(queryCount(query)).toBe(3);
  } finally { query.mockRestore(); if (external) writer.close(); }
});

test("setup imports old JSON-only writers through existing reconciliation", async () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, { brief: { goal: "review", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  expect(await first(ctx)).not.toBe("done");
  writeFileSync(join(ctx.pacerHome, "tasks", `${task.id}.json`), JSON.stringify({ ...task, rev: task.rev + 1, review: { accepted: false, at: ctx.now } }));
  expect(await first(ctx)).not.toBe("done");
  expect(reconcileTaskJson(ctx)).toBe(1);
  expect(await first(ctx)).toBe("done");
});

test("store inode replacement invalidates a cached negative", async () => {
  const ctx = fakeCtx();
  expect(await first(ctx)).not.toBe("done");
  const state = join(ctx.pacerHome, "state");
  // Move the entire old state directory, including WAL sidecars, out of the way.
  renameSync(state, `${state}.old`);
  mkdirSync(state);
  const replacement = new Database(join(state, "tasks.db"), { create: true });
  replacement.close();
  mkdirSync(join(ctx.pacerHome, "tasks"), { recursive: true });
  writeFileSync(join(ctx.pacerHome, "tasks", "t-20261010-190000-abcd.json"), JSON.stringify({
    id: "t-20261010-190000-abcd", rev: 1, createdAt: ctx.now, state: "done", attempts: [],
    brief: { goal: "restored", repo: ctx.home }, review: { accepted: false, at: ctx.now },
  }));
  expect(await first(ctx)).toBe("done");
});

for (const mutation of ["archive", "delete"] as const) test(`positive cache survives ${mutation}, fresh process re-evaluates`, async () => {
  const ctx = fakeCtx(), db = taskDatabase(ctx);
  db.run("INSERT INTO tasks(id,rev,archived,record) VALUES('fixture',1,0,'{\"review\":{\"accepted\":false}}')");
  expect(await first(ctx)).toBe("done");
  db.run("UPDATE tasks SET archived=1");
  if (mutation === "delete") db.run("DELETE FROM tasks");
  expect(await first(ctx)).toBe("done");
  // A real new module/process must not inherit reviewedHomes or reviewedVersions.
  const source = `import {checkSetup} from ${JSON.stringify(resolve("src/setup/check.ts"))};
    const ctx=${JSON.stringify({ home: ctx.home, pacerHome: ctx.pacerHome, now: ctx.now })};
    const result=await checkSetup({...ctx,env:{},which:()=>null,run:async()=>({code:127,stdout:'',stderr:''})},{snapshotProbe:false,deferStatus:true});
    console.log(result.items.find(i=>i.id==='first').status);`;
  const child = Bun.spawn([process.execPath, "-e", source], { env: { ...process.env, HOME: ctx.home, PACER_HOME: ctx.pacerHome }, stdout: "pipe", stderr: "pipe" });
  const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, errors }).toEqual({ code: 0, errors: "" });
  expect(output.trim()).not.toBe("done");
});
