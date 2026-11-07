import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { fakeCtx } from "./helpers";
import { createTask, updateTask } from "../src/tasks/store";
import { dispatchDatabase } from "../src/dispatch/store";
import { registerWork } from "../src/dispatch/work";
import { messagesDatabase } from "../src/messaging/store";
import type { Ctx } from "../src/types";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);
const OPS = "tree.status,dispatch.analytics,dispatch.learning.reset,insights.summary";

const rawLines = new WeakMap<object, string[]>();
async function exchange(home: string, requests: string[], forward: boolean, extra: Record<string, string> = {}, expectNative = !forward) {
  const child = Bun.spawn([front!, "api", "--stdio"], {
    cwd: home,
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
    const replies = lines.map(line => JSON.parse(line));
    expect(replies[0]?.result?.protocol).toBe("3.0.0");
    const ops = new Set(requests.map(request => JSON.parse(request).method as string));
    const markers = stderr.split("\n").filter(line => {
      const match = /^native (\S+) \d+$/.exec(line);
      return match != null && ops.has(match[1]!);
    });
    expect(markers).toEqual(expectNative ? requests.map((request, index) => `native ${JSON.parse(request).method} ${index + 2}`) : []);
    const result = replies.slice(1);
    rawLines.set(result, lines.slice(1));
    return result;
  } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; } }
}
/** Wire bytes; only revisions stamped from each process's own clock are masked. */
const wire = (replies: object) => rawLines.get(replies)!.map(line => line.replace(/"(revision|learningRevision)":1[7-9]\d{8}(\.\d+)?/g, '"$1":"<now>"'));
const request = (id: number, method: string, params: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });

function seed(ctx: Ctx) {
  mkdirSync(join(ctx.pacerHome, "state"), { recursive: true, mode: 0o700 });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: codex\nproviders: {codex: {}, claude-code: {}}\ndispatch:\n  learning: {enabled: true, minSamples: 25}\n");
  const make = (goal: string, repoKey = "repo-a") => {
    const task = createTask(ctx, { brief: { goal, repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
    updateTask(ctx, task.id, t => { (t as unknown as { repo: unknown }).repo = { key: repoKey }; });
    return task;
  };
  const set = (id: string, mutate: (t: Record<string, unknown>) => void) => updateTask(ctx, id, t => mutate(t as never));
  const running = (id: string) => set(id, t => { t.state = "running"; });
  const root = make("root"); running(root.id); registerWork(ctx, root.id, { allowDelegation: true });
  const child = make("child"); registerWork(ctx, child.id, {}, root.id); running(child.id);
  const grand = make("grand"); registerWork(ctx, grand.id, {}, child.id);
  const sibling = make("sibling"); registerWork(ctx, sibling.id, {}, root.id);
  const lone = make("lone", "repo-b");
  const other = make("other root"); registerWork(ctx, other.id, {});
  set(root.id, t => { t.state = "running"; t.executor = "codex#team"; t.pendingTurn = { at: 5.0, reason: "message" }; });
  set(child.id, t => { t.state = "done"; t.review = { accepted: true, at: 2 }; });
  set(grand.id, t => { t.state = "stopped"; });
  set(sibling.id, t => { t.state = "failed"; t.dismissed = 0; t.msgClosed = true; });
  set(lone.id, t => { t.state = "done"; t.origin = "external:planner"; });

  const routing = (over: Record<string, unknown>) => ({ executor: "codex#team", startedAt: 100, endedAt: 160, exitCode: 0, timedOut: false, limitHit: false, log: "", routing: over });
  set(root.id, t => { t.attempts = [
    routing({ skipped: [{ executor: "claude-code#work", reason: "busy until reset" }, { executor: "cursor", reason: "Not authorized" }, { executor: 7, reason: null }], fallback: "uncertain", why: "picked" }),
    routing({ skipped: [{ executor: "claude-code#work", reason: "busy until reset" }, null, { executor: "codex", reason: "later" }], why: "others busy" }),
  ]; });
  set(child.id, t => { t.attempts = [routing({ skipped: "not a list", why: 5 }), routing({ skipped: [{ executor: "agy", reason: "é".repeat(250) }] })]; });
  set(lone.id, t => { t.attempts = [routing({ skipped: { executor: "codex" } })]; });

  const db = dispatchDatabase(ctx);
  const settle = db.query("INSERT OR REPLACE INTO task_first_settle(task_id,at) VALUES(?,?)");
  settle.run(root.id, 1000.5); settle.run(lone.id, 2000); settle.run(other.id, 500); settle.run(child.id, 1500);
  const usage = db.query("INSERT INTO attempt_usage(task_id,attempt,root_id,executor,account,model,extractor,ended_at,kind,repo_key,outcome,ladder_rule,coverage,input,cache_read,cache_write,output,reasoning,total,turns,source,self_reported,captured_at,note) VALUES(?,?,?,?,NULL,NULL,'x',?,?,?,?,?,?,?,?,?,?,NULL,?,NULL,'s',0,0,NULL)");
  usage.run(root.id, 1, root.id, "codex#team", 1100.25, "code", "repo-a", "accepted", "capable-with-headroom", "measured", 10, 1, 2, 3, 16);
  usage.run(root.id, 2, root.id, "codex#team", 90000, "code", "repo-a", "rejected", "usable-fallback", "partial", null, null, null, 7, 7);
  usage.run(child.id, 1, root.id, "claude-code#work", 1200, null, "repo-a", null, "capable-with-headroom", "unknown", null, null, null, null, null);
  usage.run(child.id, 2, root.id, "claude-code#work", 1300, "review", "repo-a", "accepted", "", "measured", 1, 0, 0, 2, 3);
  usage.run(lone.id, 1, lone.id, "Custom Runner", 700000, "Docs", "repo-b", "accepted", "Zeta", "measured", 1, 0, 0, 0, 1);
  usage.run(other.id, 1, other.id, "123", 1150, "code", "repo-a", null, null, "measured", 5, 0, 0, 0, 5);

  const review = (repo: string, runner: string, accepted: boolean, at: number, over: Record<string, unknown> = {}) =>
    ({ taskId: "t", attempt: 1, repo, kind: "code", difficulty: "medium", runner, model: "gpt-5", settings: "h1", accepted, durationS: 12.5, usagePct: 0.3, at, provenance: "human", ...over });
  const reviews = [
    review("repo-a", "codex#team", true, 10), review("repo-a", "codex#team", false, 11.5, { durationS: null, usagePct: 1e-7 }),
    review("repo-a", "claude-code#work", true, 12, { model: null, provenance: "requesting-agent" }), review("repo-a", "codex#team", true, 13),
    review("repo-b", "codex#team", true, 14, { kind: null }), review("repo-c", "codex#team", true, 15),
    review("repo-d", "codex#team", true, 3), review("repo-d", "codex#team", true, 9),
    review("repo-a", "codex#team", true, 16, { provenance: "self" }),
    { taskId: "t", repo: "repo-a", kind: "code", difficulty: "hard", runner: "agy", accepted: 1, at: 17, provenance: "human" },
  ];
  const insert = db.query("INSERT INTO work_reviews(task_id,attempt,at,provenance,data) VALUES(?,?,?,?,?)");
  reviews.forEach((r, i) => insert.run(`t${i}`, 1, Number(r.at), String(r.provenance), JSON.stringify(r)));
  insert.run("broken", 1, 1, "human", "{not json");
  db.query("INSERT INTO work_learning_exclusions(repo) VALUES('repo-c')").run();
  db.query("INSERT INTO work_learning_reset(repo,at) VALUES('repo-d',5.5)").run();

  const mdb = messagesDatabase(ctx);
  const msg = mdb.query("INSERT INTO messages(id,task_id,root_id,sender,recipient,kind,body,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)");
  msg.run("m1", child.id, `task:${root.id}`, "human", `task:${child.id}`, "message", "hi", "pending", 1);
  msg.run("m2", child.id, `task:${root.id}`, "human", `task:${child.id}`, "message", "hi", "pending", 2);
  msg.run("m3", root.id, `task:${root.id}`, "human", `task:${root.id}`, "message", "hi", "read", 3);
  const turn = mdb.query("INSERT INTO msg_turns(id,task_id,root_id,started_at) VALUES(?,?,?,?)");
  turn.run("u1", child.id, `task:${root.id}`, 1); turn.run("u2", root.id, `task:${root.id}`, 2);
  return { root, child, grand, sibling, lone, other };
}

function seeded() {
  const ctx = fakeCtx();
  return { ctx, ids: seed(ctx) };
}

test.skipIf(!front)("tree.status, dispatch.analytics and insights.summary match forced forwarding byte for byte", async () => {
  const { ctx, ids } = seeded();
  const cases: [string, unknown][] = [
    ["tree.status", { task: ids.grand.id }], ["tree.status", { task: ids.root.id }], ["tree.status", { task: ids.lone.id }],
    ["tree.status", { task: ids.other.id }], ["tree.status", { task: "t-20990101-000000-ffff" }],
    ["tree.status", {}], ["tree.status", { task: "nope", extra: 1 }], ["tree.status", null], ["tree.status", { task: 5 }],
    ["dispatch.analytics", {}], ["dispatch.analytics", { repo: "repo-a" }], ["dispatch.analytics", { repo: "repo-a", kind: "code" }],
    ["dispatch.analytics", { repo: "repo-d" }], ["dispatch.analytics", { repo: "repo-c" }], ["dispatch.analytics", { repo: "" }],
    ["dispatch.analytics", { kind: "" }], ["dispatch.analytics", { repo: 5, extra: true }], ["dispatch.analytics", undefined],
    ["insights.summary", { from: 0, to: 86400 * 30 }], ["insights.summary", { from: 1000, to: 1300.5, repo: "repo-a" }],
    ["insights.summary", { from: 0, to: 86400 * 10, bucket: "week" }], ["insights.summary", { from: 500000, to: 800000.75 }],
    ["insights.summary", { from: 0, to: 86400 * 30, repo: "missing" }],
    ["insights.summary", {}], ["insights.summary", { from: 1, to: 1, x: 1 }], ["insights.summary", { from: 0, to: 86400 * 401 }],
    ["insights.summary", { from: -1, to: 0, bucket: "month", repo: "" }], ["insights.summary", null],
  ];
  const requests = cases.map(([op, params], index) => request(index + 2, op, params));
  const native = await exchange(ctx.home, requests, false);
  const forwarded = await exchange(ctx.home, requests, true);
  expect(native).toEqual(forwarded);
  expect(wire(native)).toEqual(wire(forwarded));
  const depthOne = [ids.child.id, ids.sibling.id].sort();
  expect(native[0]?.result?.nodes?.map((n: { id: string }) => n.id)).toEqual([ids.root.id, ...depthOne, ids.grand.id].map(id => `task:${id}`));
  expect(native[0]?.result?.turns).toBe(2);
  expect(native[10]?.result?.groups?.length).toBeGreaterThan(1);
  expect(native[18]?.result?.skipReasons?.length).toBeGreaterThan(2);
  expect(native[18]?.result?.spread?.length).toBeGreaterThan(2);
}, 60000);

test.skipIf(!front)("caller identities and huge periods follow the TypeScript gate", async () => {
  const { ctx, ids } = seeded();
  const requests = [request(2, "tree.status", { task: ids.root.id }), request(3, "tree.status", { task: ids.other.id }),
    request(4, "dispatch.analytics", {}), request(5, "insights.summary", { from: 0, to: 86400 })];
  for (const env of [{ PACER_ROLE: "executor", PACER_TASK_ID: ids.grand.id }, { PACER_ROLE: "executor" }, { CLAUDECODE: "1" }] as Record<string, string>[]) {
    const native = await exchange(ctx.home, requests, false, env);
    const forwarded = await exchange(ctx.home, requests, true, env);
    expect(native).toEqual(forwarded);
    expect(wire(native)).toEqual(wire(forwarded));
  }
  const enforced = [request(2, "dispatch.analytics", {}), request(3, "insights.summary", { from: 0, to: 1 })];
  const env = { PACER_ENFORCEMENT_TOKEN: "pet_x" };
  expect(await exchange(ctx.home, enforced, false, env)).toEqual(await exchange(ctx.home, enforced, true, env));
  const huge = [request(2, "insights.summary", { from: 1e20, to: 1e20 + 1e6 })];
  expect(wire(await exchange(ctx.home, huge, false, {}, false))).toEqual(wire(await exchange(ctx.home, huge, true)));
}, 60000);

test.skipIf(!front)("dispatch.learning.reset writes the same learning controls as TypeScript", async () => {
  // Two seeded homes: copying a live store makes the task-store import run again on Linux.
  const homes = [seeded().ctx.home, seeded().ctx.home];
  const requests = [
    request(2, "dispatch.learning.reset", { repo: "repo-a", excluded: true, expect_rev: 0 }),
    request(3, "dispatch.learning.reset", { repo: "repo-a", expect_rev: 0 }),
    request(4, "dispatch.learning.reset", { repo: "repo-c", expect_rev: 0 }),
    request(5, "dispatch.learning.reset", { repo: "repo-d", expect_rev: 5.5, extra: 1 }),
    request(6, "dispatch.learning.reset", { repo: "", excluded: "yes", expect_rev: -1 }),
    request(7, "dispatch.learning.reset", {}),
    request(8, "dispatch.analytics", { repo: "repo-a" }),
    request(9, "dispatch.analytics", { repo: "repo-c" }),
  ];
  const native = await exchange(homes[0]!, requests, false);
  const forwarded = await exchange(homes[1]!, requests, true);
  expect(wire(native)).toEqual(wire(forwarded));
  expect(native[0]?.result?.reset).toBe(true);
  expect(native[1]?.error?.data?.code).toBe("conflict");
  const state = (home: string) => {
    const db = new Database(join(home, ".pacer", "state", "tasks.db"));
    try {
      return {
        reset: db.query<{ repo: string; at: number }, []>("SELECT repo, at FROM work_learning_reset ORDER BY repo").all().map(r => ({ repo: r.repo, at: r.at > 1e9 ? "<now>" : r.at })),
        excluded: db.query<{ repo: string }, []>("SELECT repo FROM work_learning_exclusions ORDER BY repo").all(),
      };
    } finally { db.close(); }
  };
  expect(state(homes[0]!)).toEqual(state(homes[1]!));
  expect(state(homes[0]!).excluded).toEqual([{ repo: "repo-a" }]);
}, 60000);
