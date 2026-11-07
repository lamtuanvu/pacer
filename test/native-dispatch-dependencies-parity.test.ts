import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { dispatchDatabase } from "../src/dispatch/store";
import { registerWork } from "../src/dispatch/work";
import type { Ctx } from "../src/types";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);
const OPS = "dispatch.dependencies,dispatch.dependencies.waive";

/** Runs one stdio session; `forwardedIndexes` are requests the native front door must still forward. */
async function exchange(home: string, requests: string[], forward: boolean, forwardedIndexes = new Set<number>(), extra: Record<string, string> = {}) {
  const child = Bun.spawn([front!, "api", "--stdio"], {
    env: { HOME: home, PACER_HOME: join(home, ".pacer"), PATH: process.env.PATH ?? "/usr/bin:/bin",
      PACER_CORE_ARGV: core, PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off",
      PACER_DEBUG_NATIVE: "1", ...extra, ...(forward ? { PACER_FORWARD_OPS: OPS } : {}) },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  try {
    await child.stdin.write([JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } }), ...requests].join("\n") + "\n");
    await child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    const lines = stdout.trim().split("\n");
    expect(JSON.parse(lines[0]!).result?.protocol).toBe("3.0.0");
    const markers = stderr.split("\n").filter(line => /^native dispatch\.dependencies(\.waive)? \d+$/.test(line));
    const expected = forward ? [] : requests.flatMap((r, index) => forwardedIndexes.has(index) ? [] : [`native ${JSON.parse(r).method} ${index + 2}`]);
    expect(markers).toEqual(expected);
    return lines.slice(1);
  } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; } }
}

const request = (id: number, method: string, params: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });

/** Wire bytes with only clock-derived wait figures masked. */
const wire = (lines: string[]) => lines.map(line =>
  line.replace(/"(waitAsOf|queueWaitSeconds|dependencyWaitSeconds|childWaitSeconds|capacityWaitSeconds)":-?[\d.e+-]+/g, '"$1":"<t>"'));

function seed(ctx: Ctx) {
  mkdirSync(join(ctx.pacerHome, "state"), { recursive: true, mode: 0o700 });
  const make = (goal: string) => createTask(ctx, { brief: { goal, repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const set = (id: string, mutate: (t: Record<string, unknown>) => void) => updateTask(ctx, id, t => mutate(t as never));
  const root = make("root"); set(root.id, t => { t.state = "running"; });
  registerWork(ctx, root.id, { allowDelegation: true });
  const child = (goal: string, parent = root.id) => { const task = make(goal); registerWork(ctx, task.id, {}, parent); return task; };
  const a = child("queued a"), b = child("done b"), c = child("failed c"), d = child("accepted d");
  set(a.id, t => { t.state = "running"; });
  const g = child("grandchild", a.id);
  set(a.id, t => { t.state = "queued"; });
  set(b.id, t => { t.state = "done"; });
  set(c.id, t => { t.state = "failed"; });
  set(d.id, t => { t.state = "done"; t.review = { accepted: true, at: 1 }; });
  const other = make("other root"); registerWork(ctx, other.id, {});
  const bare = make("no work node");
  const db = dispatchDatabase(ctx);
  db.query("INSERT INTO work_dependency_waivers(task_id,dependency_id,reason,at) VALUES(?,?,?,?)").run(a.id, d.id, "old", 5);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const rev = (id: string) => readTask(ctx, id)!.rev;
  return { root, a, b, c, d, g, other, bare, rev };
}

/** Durable effects, with times written by the request clock masked. */
function dump(ctx: Ctx, seededAt: number) {
  const db = new Database(join(ctx.pacerHome, "state", "tasks.db"));
  const t = (v: unknown) => typeof v === "number" && v > seededAt + 1 ? "<now>" : v;
  try {
    return {
      tasks: db.query<{ id: string; rev: number; state: string; updated_at: number; settled_at: number | null; record: string }, []>("SELECT id,rev,state,updated_at,settled_at,record FROM tasks ORDER BY id").all()
        .map(r => ({ ...r, updated_at: t(r.updated_at) })),
      nodes: db.query("SELECT task_id,dependencies FROM work_nodes ORDER BY task_id").all(),
      events: db.query<{ at: number }, []>("SELECT seq,task_id,at,kind,data FROM work_events ORDER BY seq").all().map(r => ({ ...r, at: t(r.at) })),
      waits: db.query<{ started_at: number | null; total_seconds: number }, []>("SELECT task_id,kind,started_at,total_seconds,refs FROM work_waits ORDER BY task_id,kind").all()
        .map(r => ({ ...r, started_at: t(r.started_at), total_seconds: typeof r.total_seconds })),
      waivers: db.query<{ at: number }, []>("SELECT task_id,dependency_id,reason,at FROM work_dependency_waivers ORDER BY task_id,dependency_id").all().map(r => ({ ...r, at: t(r.at) })),
      files: Object.fromEntries(readdirSync(join(ctx.pacerHome, "tasks")).sort().map(name => [name, readFileSync(join(ctx.pacerHome, "tasks", name), "utf8")])),
    };
  } finally { db.close(); }
}

/**
 * Task JSON mtimes must survive the copy to the nanosecond, or the store treats every task as edited and re-indexes it.
 * Recursive cpSync resets them on Linux and preserveTimestamps truncates them to milliseconds; `cp -Rp` keeps them exact.
 */
function snapshot(from: string, to: string) {
  const copy = Bun.spawnSync(["cp", "-Rp", from, to], { stderr: "pipe" });
  expect(copy.exitCode, copy.stderr.toString()).toBe(0);
}

async function both(ctx: Ctx, backup: string, requests: string[], forwardedIndexes = new Set<number>(), extra: Record<string, string> = {}) {
  const run = async (forward: boolean) => {
    rmSync(ctx.pacerHome, { recursive: true, force: true });
    snapshot(backup, ctx.pacerHome);
    const lines = await exchange(ctx.home, requests, forward, forwardedIndexes, extra);
    return { lines, state: dump(ctx, ctx.now) };
  };
  const native = await run(false), forwarded = await run(true);
  expect(wire(native.lines)).toEqual(wire(forwarded.lines));
  expect(native.state).toEqual(forwarded.state);
  return native.lines.map(line => JSON.parse(line));
}

test.skipIf(!front)("dependency edits and waivers match forced forwarding in replies and durable effects", async () => {
  const ctx = fakeCtx();
  const s = seed(ctx);
  const backup = join(ctx.home, "backup");
  snapshot(ctx.pacerHome, backup);
  const ra = s.rev(s.a.id), rb = s.rev(s.b.id), rr = s.rev(s.root.id);
  const split = `a${"😀".repeat(1500)}`;
  const cases: [string, unknown][] = [
    ["dispatch.dependencies", { id: s.a.id, dependencies: [s.b.id, s.c.id, s.b.id, s.d.id], expect_rev: ra }],
    ["dispatch.dependencies", { id: s.a.id, dependencies: [], expect_rev: ra }],
    ["dispatch.dependencies", { id: s.a.id, dependencies: [s.a.id], expect_rev: ra + 1 }],
    ["dispatch.dependencies", { id: s.a.id, dependencies: [s.other.id], expect_rev: ra + 1 }],
    ["dispatch.dependencies", { id: s.a.id, dependencies: [s.b.id, "t-20990101-000000-ffff"], expect_rev: ra + 1 }],
    ["dispatch.dependencies", { id: s.b.id, dependencies: [s.g.id], expect_rev: rb }],
    ["dispatch.dependencies", { id: s.g.id, dependencies: [s.b.id], expect_rev: s.rev(s.g.id) }],
    ["dispatch.dependencies", { id: "t-20990101-000000-ffff", dependencies: [], expect_rev: 1 }],
    ["dispatch.dependencies", { id: s.bare.id, dependencies: [], expect_rev: 99 }],
    ["dispatch.dependencies.waive", { id: s.a.id, dependency: s.b.id, reason: "\ufeff  not needed \u0085", expect_rev: ra + 1 }],
    ["dispatch.dependencies.waive", { id: s.a.id, dependency: s.c.id, reason: "😀".repeat(2000), expect_rev: ra + 2 }],
    ["dispatch.dependencies.waive", { id: s.root.id, dependency: s.a.id, reason: "child is fine", expect_rev: rr }],
    ["dispatch.dependencies.waive", { id: s.a.id, dependency: s.root.id, reason: "nope", expect_rev: ra + 3 }],
    ["dispatch.dependencies.waive", { id: s.a.id, dependency: s.g.id, reason: "stale", expect_rev: ra }],
    ["dispatch.dependencies.waive", { id: s.a.id, dependency: s.g.id, reason: " \u3000 ", expect_rev: 1.5 }],
    ["dispatch.dependencies.waive", { id: s.a.id, dependency: s.g.id, reason: "x".repeat(2001), expect_rev: 0 }],
    ["dispatch.dependencies.waive", { id: 5, reason: 7, expect_rev: "1" }],
    ["dispatch.dependencies.waive", { id: s.a.id, dependency: s.g.id, reason: "direct child", expect_rev: ra + 3 }],
    ["dispatch.dependencies", { id: s.a.id, dependencies: [], expect_rev: ra + 4 }],
    ["dispatch.dependencies", { id: "", dependencies: [1, "", "😀".repeat(129)], expect_rev: -1e300 }],
    ["dispatch.dependencies", { id: "x", dependencies: Array(101).fill("y"), expect_rev: 1e300 }],
    ["dispatch.dependencies", { id: "x", dependencies: "y", expect_rev: null }],
    ["dispatch.dependencies", {}], ["dispatch.dependencies", undefined], ["dispatch.dependencies", null],
    ["dispatch.dependencies.waive", [1]],
  ];
  const requests = cases.map(([op, params], index) => request(index + 2, op, params));
  const replies = await both(ctx, backup, requests);

  const nodeOf = (reply: { result: { nodes: { taskId: string }[] } }, id: string) => reply.result.nodes.find(n => n.taskId === id) as Record<string, unknown>;
  expect(nodeOf(replies[0], s.a.id)).toMatchObject({ dependencies: [s.b.id, s.c.id, s.d.id], rev: ra + 1 });
  expect(replies.slice(1, 9).map(r => [r.error?.data?.code, r.error?.message])).toEqual([
    ["conflict", "Task changed"], ["invalid_input", "Invalid dependency"], ["invalid_input", "Invalid dependency"],
    ["invalid_input", "Invalid dependency"], [undefined, undefined], ["invalid_input", "Dependency cycle"],
    ["unknown_task", "Unknown work"], ["unknown_task", "Unknown work"],
  ]);
  expect(nodeOf(replies[11], s.root.id).waivedChildren).toEqual([s.a.id]);
  expect(replies[12].error?.message).toBe("Not a dependency or direct child of this work");
  expect(replies[13].error?.data?.code).toBe("conflict");
  expect(nodeOf(replies[17], s.a.id).waivedChildren).toContain(s.g.id);
  expect(replies[18].result.nodes.find((n: { taskId: string }) => n.taskId === s.a.id).dependencies).toEqual([]);
  expect(replies.slice(15).every(r => r.error?.data?.code === "invalid_input" || r.result)).toBe(true);

  // A cut through a surrogate pair cannot be held in a Rust string, so only that input stays on TypeScript.
  const forwarded = await both(ctx, backup, [request(2, "dispatch.dependencies.waive", { id: s.a.id, dependency: s.g.id, reason: split, expect_rev: ra })], new Set([0]));
  expect(nodeOf(forwarded[0], s.a.id).waivedChildren).toEqual([s.d.id, s.g.id].sort());
}, 120000);

test.skipIf(!front)("dependency writes refuse executor and enforcement identities like the TypeScript core", async () => {
  const ctx = fakeCtx();
  const s = seed(ctx);
  const backup = join(ctx.home, "backup");
  snapshot(ctx.pacerHome, backup);
  const requests = [
    request(2, "dispatch.dependencies", { id: s.a.id, dependencies: [], expect_rev: s.rev(s.a.id) }),
    request(3, "dispatch.dependencies.waive", { id: s.a.id, dependency: s.d.id, reason: "x", expect_rev: s.rev(s.a.id) }),
  ];
  for (const env of [{ PACER_ROLE: "executor" }, { PACER_ENFORCEMENT_TOKEN: "pet_x" }] as Record<string, string>[]) {
    const replies = await both(ctx, backup, requests, new Set(), env);
    expect(replies.map(r => r.error?.data?.code)).toEqual(["not_allowed", "not_allowed"]);
  }
}, 60000);
