import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { dispatchDatabase } from "../src/dispatch/store";
import { registerWork, setWorkDependencies, waiveWorkDependency } from "../src/dispatch/work";
import type { Ctx } from "../src/types";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);
const OPS = "dispatch.config.get,dispatch.tree,dispatch.list,dispatch.events";

async function exchange(home: string, requests: string[], forward: boolean, extra: Record<string, string> = {}, expectNative = !forward) {
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
    const replies = stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(replies[0]?.result?.protocol).toBe("3.0.0");
    const ops = new Set(requests.map(request => JSON.parse(request).method as string));
    const markers = stderr.split("\n").filter(line => {
      const match = /^native (\S+) \d+$/.exec(line);
      return match != null && ops.has(match[1]!);
    });
    expect(markers).toEqual(expectNative ? requests.map((request, index) => `native ${JSON.parse(request).method} ${index + 2}`) : []);
    const result = replies.slice(1);
    rawLines.set(result, stdout.trim().split("\n").slice(1));
    return result;
  } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; } }
}
const rawLines = new WeakMap<object, string[]>();
/** Wire bytes, with only the clock-derived fields masked; parsed comparison alone hides number formatting. */
const wire = (replies: object) => rawLines.get(replies)!.map(line => line.replace(/"(waitAsOf|capturedAt)":\d{10}(\.\d+)?/g, '"$1":"<now>"'));

const request = (id: number, method: string, params: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });

/** Values that depend on each process's own clock. */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (key === "waitAsOf" && typeof item === "number") out[key] = "<now>";
    else if (key === "capturedAt" && record.coverage === "unknown" && typeof item === "number") out[key] = "<now>";
    else out[key] = normalize(item);
  }
  return out;
}

const attempt = (over: Record<string, unknown> = {}) => ({
  executor: "codex#team", model: "gpt-5", startedAt: 100, endedAt: 160, exitCode: 1, timedOut: false, limitHit: false, log: "", ...over,
});
const tokens = (over: Record<string, unknown> = {}) => ({
  coverage: "measured", input: 10, cacheRead: 5, cacheWrite: null, output: 7, reasoning: 2, total: 22, turns: 1,
  source: "executor-json", selfReported: false, extractor: "codex@1", capturedAt: 170, ...over,
});
const usage = (over: Record<string, unknown> = {}) => ({
  account: "team", usedPct: 10, window: "5h", at: 100, poolId: "pool-a", resetEpoch: 1000, capturedAt: 100, observationId: "o1", stale: false, ...over,
});

function seed(ctx: Ctx) {
  mkdirSync(join(ctx.pacerHome, "state"), { recursive: true, mode: 0o700 });
  const make = (goal: string, repo = ctx.home) =>
    createTask(ctx, { brief: { goal, repo }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const set = (id: string, mutate: (t: Record<string, unknown>) => void) => updateTask(ctx, id, t => mutate(t as never));
  const running = (id: string) => set(id, t => { t.state = "running"; });

  const root = make("root work");
  running(root.id);
  registerWork(ctx, root.id, { allowDelegation: true });
  const child = (goal: string, options: Record<string, unknown> = {}, parent = root.id) => {
    const task = make(goal);
    registerWork(ctx, task.id, options, parent);
    return task;
  };
  const stoppedParent = child("stopped parent");
  running(stoppedParent.id);
  const grandchild = child("grandchild", {}, stoppedParent.id);
  const accepted = child("accepted child");
  const active = child("active child");
  const missingTree = child("missing worktree");
  const expired = child("expired child", { expiresAt: 1 });
  const exhausted = child("exhausted child");
  const blocked = child("blocked child");
  const asking = child("asking child");
  const queued = child("queued child");
  const rejected = child("rejected child");
  const archivedIndexed = child("archived with usage");
  const archivedBare = child("archived without usage");

  set(stoppedParent.id, t => { t.state = "stopped"; });
  set(grandchild.id, t => { t.state = "failed"; t.attempts = [attempt()]; });
  set(accepted.id, t => {
    t.state = "done"; t.review = { accepted: true, at: 200 }; t.title = "Accepted title";
    t.attempts = [
      attempt({ startedAt: 100.1, endedAt: 160.35, tokens: tokens(), usageAtStart: usage({ usedPct: 10.1 }), usageAtEnd: usage({ usedPct: 15.35, capturedAt: 160.2, observationId: "o2" }), actualModel: "gpt-5-codex" }),
      attempt({ executor: "claude-code#work", startedAt: 150, endedAt: 210, usageAtStart: usage({ capturedAt: 150, usedPct: 12, observationId: "o3" }), usageAtEnd: usage({ capturedAt: 220, usedPct: 18, observationId: "o4" }) }),
    ];
    t.result = { model: "result-model" };
  });
  set(active.id, t => { t.state = "failed"; t.runnerPid = process.pid; t.attempts = [attempt({ usageAtStart: usage({ account: "other", poolId: null }) })]; });
  set(missingTree.id, t => { t.state = "failed"; t.worktree = join(ctx.home, "gone-worktree"); });
  set(expired.id, t => { t.state = "partial"; });
  set(exhausted.id, t => { t.state = "limit"; t.attempts = [attempt(), attempt(), attempt({ tokens: tokens({ coverage: "partial", total: null, output: null }) })]; });
  setWorkDependencies(ctx, blocked.id, [active.id], readTask(ctx, blocked.id)!.rev);
  set(blocked.id, t => { t.state = "failed"; });
  set(asking.id, t => { t.state = "running"; t.question = { text: "Which branch?", at: 150 }; });
  set(rejected.id, t => { t.state = "done"; t.review = { accepted: false, note: "redo", at: 300 }; });
  waiveWorkDependency(ctx, root.id, rejected.id, "not needed", readTask(ctx, root.id)!.rev);

  const db = dispatchDatabase(ctx);
  db.query("INSERT INTO work_decisions(task_id,attempt,data) VALUES(?,?,?)").run(accepted.id, 1, JSON.stringify({ engine: "ladder", proposal: { step: "a" }, validation: null, recommendedAction: "run", selectedCandidateId: "c1", inputHash: "i", outputHash: "o", fallback: false, enforcement: { mode: "strict" }, extra: 1 }));
  db.query("INSERT INTO work_decisions(task_id,attempt,data) VALUES(?,?,?)").run(accepted.id, 2, JSON.stringify({ engine: "plugin:x", enforcement: null }));
  const usageRow = "INSERT INTO attempt_usage(task_id,attempt,root_id,executor,account,model,extractor,ended_at,coverage,input,cache_read,cache_write,output,reasoning,total,turns,source,self_reported,captured_at,note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)";
  db.query(usageRow).run(accepted.id, 2, root.id, "claude-code#work", null, "opus", "claude@1", 210, "measured", 3, 0, 1, 4, null, 8, 2, "executor-json", 0, 215, null);
  db.query(usageRow).run(archivedIndexed.id, 1, root.id, "cursor#me", "me", "auto", "cursor@1", 300, "partial", null, null, null, 9, null, null, null, "executor-text", 1, 305, "partial capture");
  for (const archived of [archivedIndexed.id, archivedBare.id]) {
    db.query("DELETE FROM tasks WHERE id=?").run(archived);
    rmSync(join(ctx.pacerHome, "tasks", `${archived}.json`), { force: true });
  }
  db.query("INSERT INTO work_waits(task_id,kind,started_at,total_seconds,refs) VALUES(?,?,?,?,?)").run(accepted.id, "capacity", null, 12.5, 0);
  db.query("INSERT INTO work_waits(task_id,kind,started_at,total_seconds,refs) VALUES(?,?,?,?,?)").run(asking.id, "child", null, 3, 0);
  db.query("UPDATE work_waits SET started_at=9e9 WHERE started_at IS NOT NULL").run();
  const event = db.query("INSERT INTO work_events(root_id,task_id,at,kind,data) VALUES(?,?,?,?,?)");
  event.run(root.id, grandchild.id, 1700000000.125, "numbers", '{"int":2.0,"exp":1e21,"tiny":1e-7,"negZero":-0.0,"big":12345678901234567890,"neg":-9007199254740993,"nested":[1.50,{"u":"\\u2028"}]}');
  for (let n = 0; n < 520; n++) event.run(root.id, n % 2 ? grandchild.id : accepted.id, 1700000001 + n / 4, "bulk", JSON.stringify({ n }));

  const remote = make("remote root"); set(remote.id, t => { t.run = { remoteBranch: "feature/remote" }; t.state = "done"; });
  registerWork(ctx, remote.id, {});
  const fresh = make("new-mode root"); set(fresh.id, t => { t.run = { mode: "new" }; t.repo = { key: "repo-two" }; t.state = "failed"; });
  registerWork(ctx, fresh.id, {});
  const hosted = make("hosted root"); set(hosted.id, t => { t.run = { host: "box" }; t.state = "stopped"; });
  registerWork(ctx, hosted.id, {});
  const linked = make("linked worktree root");
  const linkedDir = join(ctx.home, "linked"), gitDir = join(ctx.home, "gitdirs", "linked");
  mkdirSync(linkedDir, { recursive: true }); mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(linkedDir, ".git"), "gitdir: ../gitdirs/linked\n");
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/topic/linked  \n");
  set(linked.id, t => { t.worktree = linkedDir; t.state = "partial"; });
  registerWork(ctx, linked.id, {});
  const plain = make("plain worktree root");
  const plainDir = join(ctx.home, "plain");
  mkdirSync(join(plainDir, ".git"), { recursive: true });
  writeFileSync(join(plainDir, ".git", "HEAD"), "ref: refs/heads/main\n");
  set(plain.id, t => { t.run = { workdir: plainDir }; t.state = "limit"; });
  registerWork(ctx, plain.id, {});
  const detached = make("detached root");
  const detachedDir = join(ctx.home, "detached");
  mkdirSync(join(detachedDir, ".git"), { recursive: true });
  writeFileSync(join(detachedDir, ".git", "HEAD"), "0123456789abcdef\n");
  set(detached.id, t => { t.result = { worktree: detachedDir }; t.state = "done"; });
  registerWork(ctx, detached.id, {});

  return { root, stoppedParent, grandchild, accepted, active, blocked, asking, queued, rejected, archivedIndexed, archivedBare, fresh };
}

test.skipIf(!front)("dispatch work-graph reads match forced forwarding with exact native traces", async () => {
  const ctx = fakeCtx();
  const ids = seed(ctx);
  const cases: [string, unknown][] = [
    ["dispatch.tree", { id: ids.root.id }],
    ["dispatch.tree", { id: ids.stoppedParent.id }],
    ["dispatch.tree", { id: ids.accepted.id }],
    ["dispatch.tree", { id: ids.archivedIndexed.id }],
    ["dispatch.tree", { id: "t-20990101-000000-ffff" }],
    ["dispatch.tree", {}], ["dispatch.tree", { id: "" }], ["dispatch.tree", { id: 5 }],
    ["dispatch.tree", { id: "😀".repeat(129) }], ["dispatch.tree", { id: "😀".repeat(128) }],
    ["dispatch.tree", undefined], ["dispatch.tree", null], ["dispatch.tree", [1]],
    ["dispatch.events", { id: ids.root.id }],
    ["dispatch.events", { id: ids.stoppedParent.id }],
    ["dispatch.events", { id: ids.root.id, after: 3 }],
    ["dispatch.events", { id: ids.root.id, after: 500 }],
    ["dispatch.events", { id: ids.grandchild.id, after: 20 }],
    ["dispatch.events", { id: ids.root.id, after: 1e9 }],
    ["dispatch.events", { id: ids.root.id, after: -1 }],
    ["dispatch.events", { id: ids.root.id, after: 1.5 }],
    ["dispatch.events", { id: ids.root.id, after: "2" }],
    ["dispatch.events", { id: ids.root.id, after: null }],
    ["dispatch.events", { id: ids.root.id, after: 9_007_199_254_740_992 }],
    ["dispatch.events", { id: "missing" }],
    ["dispatch.events", { after: -1 }],
    ["dispatch.list", {}],
    ["dispatch.list", { relation: "children" }],
    ["dispatch.list", { relation: "all", limit: 3 }],
    ["dispatch.list", { relation: "all", state: "needs_input" }],
    ["dispatch.list", { relation: "all", state: "running" }],
    ["dispatch.list", { relation: "children", state: "failed", limit: 2 }],
    ["dispatch.list", { repo: "repo-two" }],
    ["dispatch.list", { repo: "nothing" }],
    ["dispatch.list", { relation: "all", before: ids.fresh.id, limit: 4 }],
    ["dispatch.list", { relation: "bogus" }],
    ["dispatch.list", { state: "archived", limit: 0, repo: "", before: "" }],
    ["dispatch.list", { limit: 101 }], ["dispatch.list", { limit: 2.5 }], ["dispatch.list", { limit: "5" }],
    ["dispatch.list", { before: "😀".repeat(129), relation: 1 }],
    ["dispatch.list", { relation: null }],
    ["dispatch.list", "roots"],
  ];
  const requests = cases.map(([op, params], index) => request(index + 2, op, params));
  const native = await exchange(ctx.home, requests, false);
  const forwarded = await exchange(ctx.home, requests, true);
  expect(normalize(native)).toEqual(normalize(forwarded));
  expect(wire(native)).toEqual(wire(forwarded));

  const tree = native[0]?.result;
  expect(tree?.nodes?.length).toBe(14);
  const reasons = Object.fromEntries(tree.nodes.map((n: { title: string; retryEligibility: { reason?: string } }) => [n.title, n.retryEligibility.reason ?? "allowed"]));
  expect(reasons).toMatchObject({
    grandchild: "A stopped ancestor cannot resume child work", "Accepted title": "Work is not eligible for another attempt",
    "active child": "Previous executor is still active", "missing worktree": "Task worktree is unavailable",
    "expired child": "Work deadline has expired", "exhausted child": "Managed work attempt limit reached",
    "blocked child": "Required dependencies have not been reviewed", "asking child": "allowed", "rejected child": "allowed",
    "Archived work": "Archived work",
  });
  expect(tree.totals.usagePools.length).toBeGreaterThan(1);
  expect(native[1]?.result?.nodes?.map((n: { taskId: string }) => n.taskId)).toEqual([ids.stoppedParent.id, ids.grandchild.id]);
  expect(native[4]?.error?.data?.code).toBe("unknown_task");
  const listAll = cases.findIndex(([op, p]) => op === "dispatch.list" && JSON.stringify(p) === JSON.stringify({ relation: "all", limit: 3 }));
  expect(native[listAll]?.result?.next).toBeString();
  const branches = native[cases.findIndex(([op, p]) => op === "dispatch.list" && JSON.stringify(p) === "{}")]?.result?.tasks
    .map((t: { title: string; branch: string | null }) => [t.title, t.branch]);
  expect(Object.fromEntries(branches)).toMatchObject({
    "remote root": "feature/remote", "new-mode root": `pacer/${ids.fresh.id}`, "hosted root": null,
    "linked worktree root": "topic/linked", "plain worktree root": "main", "detached root": null, "root work": null,
  });
  const needsInput = native[cases.findIndex(([, p]) => JSON.stringify(p) === JSON.stringify({ relation: "all", state: "needs_input" }))]?.result?.tasks;
  expect(needsInput.map((t: { id: string }) => t.id)).toEqual([ids.asking.id]);
}, 60000);

test.skipIf(!front)("dispatch reads refuse executor and enforcement identities like the TypeScript core", async () => {
  const ctx = fakeCtx();
  const ids = seed(ctx);
  const requests = [
    request(2, "dispatch.tree", { id: ids.root.id }), request(3, "dispatch.list", { limit: 0 }),
    request(4, "dispatch.events", {}), request(5, "dispatch.config.get", {}),
  ];
  for (const env of [{ PACER_ROLE: "executor" }, { PACER_ENFORCEMENT_TOKEN: "pet_x" }, { PACER_ENFORCEMENT_TOKEN: "", PACER_ROLE: "planner" }] as Record<string, string>[]) {
    const native = await exchange(ctx.home, requests, false, env);
    const forwarded = await exchange(ctx.home, requests, true, env);
    expect(normalize(native)).toEqual(normalize(forwarded));
    expect(wire(native)).toEqual(wire(forwarded));
    if (env.PACER_ROLE !== "planner") expect(native.map(reply => reply.error?.data?.code)).toEqual(["not_allowed", "not_allowed", "not_allowed", "not_allowed"]);
  }
}, 60000);

test.skipIf(!front)("dispatch.config.get matches forced forwarding for missing, built-in and strategy configuration", async () => {
  const ctx = fakeCtx();
  mkdirSync(join(ctx.pacerHome, "state"), { recursive: true, mode: 0o700 });
  const requests = [request(2, "dispatch.config.get", {}), request(3, "dispatch.config.get", { extra: true }),
    request(4, "dispatch.config.get", undefined), request(5, "dispatch.config.get", [])];
  // The YAML parsers word syntax errors differently; strategy-write-parity accepts the same divergence.
  const parserText = (replies: { error?: { message: string } }[]) => replies.map(reply => reply.error
    ? { ...reply, error: { ...reply.error, message: reply.error.message.replace(/YAML syntax error: .*$/m, "YAML syntax error: <parser>") } } : reply);
  const compare = async () => {
    const native = await exchange(ctx.home, requests, false);
    const forwarded = await exchange(ctx.home, requests, true);
    expect(parserText(native)).toEqual(parserText(forwarded));
    if (!native.some(reply => reply.error?.message?.includes("YAML syntax error"))) expect(wire(native)).toEqual(wire(forwarded));
    return native;
  };
  const missing = await compare();
  expect(missing[0]?.error?.data?.code).toBe("internal");
  const strategy = join(ctx.pacerHome, "strategy.yaml");
  writeFileSync(strategy, "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\n");
  expect((await compare())[0]?.result?.source).toBe("built-in");
  writeFileSync(strategy, "accounts:\n  work: {kind: claude}\nplanner: claude-code#work\nrouting: []\ndispatch:\n  timeoutMs: 2500\n  learning: {enabled: true}\n");
  const configured = await compare();
  expect(configured[0]?.result).toMatchObject({ source: "strategy", planner: "claude-code", plannerAccount: "work" });
  writeFileSync(strategy, JSON.stringify({ planner: "codex#team", routing: [{ default: ["codex#personal"] }], runners: { "codex#team": {}, "codex#personal": {} },
    accounts: { team: { kind: "codex", home: join(ctx.home, "accounts/team") }, personal: { kind: "codex", home: join(ctx.home, "accounts/personal") } } }));
  expect((await compare())[0]?.result).toMatchObject({ planner: "codex", plannerAccount: "team" });
  mkdirSync(join(ctx.pacerHome, "strategies"), { recursive: true });
  writeFileSync(join(ctx.pacerHome, "active"), "alt\n");
  writeFileSync(join(ctx.pacerHome, "strategies", "alt.yaml"), "planner: codex\nproviders: {codex: {}}\ndispatch: {steps: [{id: only, capacity: unknown}]}\n");
  const alt = await compare();
  expect(alt[0]?.result?.strategy).toBe("alt");
  writeFileSync(join(ctx.pacerHome, "strategies", "alt.yaml"), "planner: [\n");
  expect((await compare())[0]?.error?.data?.code).toBe("internal");
}, 60000);
