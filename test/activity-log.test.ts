import { repoFor } from "../src/core/repos";
import { expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendActivity, readActivity, rotateActivity } from "../src/activity/log";
import * as tasks from "../src/core/tasks";
import { callOp } from "../src/api/ops";
import { pumpOnce, type PumpDeps } from "../src/link/pump";
import { reduce } from "../src/link/envelope";
import { readLatest } from "../src/link/store";
import { latestPath } from "../src/link/paths";
import { writeJsonAtomic } from "../src/fsutil";
import { updateTask } from "../src/tasks/store";
import type { Status } from "../src/engine/status";
import { fakeCtx } from "./helpers";

const file = (ctx: ReturnType<typeof fakeCtx>) => join(ctx.pacerHome, "state", "activity.jsonl");
async function configured() {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n");
  return ctx;
}

test("delegate then review records exact texts, newest first, with repo key", async () => {
  const ctx = await configured();
  const task = tasks.delegate(ctx, { brief: { goal: "Add SSH keepalive", repo: ctx.home }, executor: "codex" }, () => 1);
  updateTask(ctx, task.id, t => { t.state = "done"; });
  tasks.review(ctx, task.id, { accepted: true });
  expect(readActivity(ctx, {}).entries).toMatchObject([
    { kind: "verdict", text: "Accepted “Add SSH keepalive”", taskId: task.id, repo: repoFor(ctx, ctx.home).key },
    { kind: "task_started", text: "Delegated “Add SSH keepalive” to Codex", taskId: task.id },
  ]);
});

test("before pages tied timestamps without overlap; filters and callback work", () => {
  const ctx = fakeCtx(), observed: string[] = [];
  const a = appendActivity(ctx, { kind: "config", level: "info", text: "first", repo: "a" }, e => observed.push(e.id));
  appendActivity(ctx, { kind: "mode", level: "warn", text: "second", repo: "b" });
  appendActivity(ctx, { kind: "config", level: "info", text: "third", repo: "a", taskId: "t-one" });
  const first = readActivity(ctx, { limit: 2 }), second = readActivity(ctx, { before: first.next!, limit: 2 });
  expect(first.entries.map(e => e.text)).toEqual(["third", "second"]);
  expect(second.entries.map(e => e.id)).toEqual([a.id]);
  expect(second.next).toBeNull();
  expect(observed).toEqual([a.id]);
  expect(a.id).toMatch(new RegExp(`^${ctx.now}-[a-f0-9]{4}$`));
  expect(readActivity(ctx, { repo: "a", kinds: ["config"], taskId: "t-one" }).entries.map(e => e.text)).toEqual(["third"]);
  expect(readActivity(ctx, { repo: "a", kinds: ["mode"] }).entries).toEqual([]);
});

test("corrupt and malformed lines are skipped", () => {
  const ctx = fakeCtx();
  appendActivity(ctx, { kind: "config", level: "info", text: "first" });
  appendFileSync(file(ctx), 'not json\nnull\n{"id":"broken"}\n');
  appendActivity(ctx, { kind: "config", level: "info", text: "last" });
  expect(readActivity(ctx, {}).entries.map(e => e.text)).toEqual(["last", "first"]);
});

test("the activity log keeps its state directory at 0700 and narrows an existing, wider one (SEC-7)", () => {
  const ctx = fakeCtx();
  appendActivity(ctx, { kind: "config", level: "info", text: "fresh" });
  expect(statSync(join(ctx.pacerHome, "state")).mode & 0o777).toBe(0o700);
  expect(statSync(file(ctx)).mode & 0o777).toBe(0o600);
  // mkdirSync's mode does not apply to an existing directory, so a 0755 state/ is narrowed on the next append.
  chmodSync(join(ctx.pacerHome, "state"), 0o755);
  appendActivity(ctx, { kind: "config", level: "info", text: "narrowed" });
  expect(statSync(join(ctx.pacerHome, "state")).mode & 0o777).toBe(0o700);
});

test("an entry appended after an interrupted append starts on a new line (SEC-7 append exception)", () => {
  const ctx = fakeCtx();
  appendActivity(ctx, { kind: "config", level: "info", text: "first" });
  appendFileSync(file(ctx), '{"id":"torn","at":1,"kind":"con');
  const next = appendActivity(ctx, { kind: "config", level: "info", text: "next" });
  expect(readFileSync(file(ctx), "utf8").split("\n").at(-2)).toBe(JSON.stringify(next));
  appendActivity(ctx, { kind: "config", level: "info", text: "last" });
  expect(readActivity(ctx, {}).entries.map(e => e.text)).toEqual(["last", "next", "first"]);
  expect(readActivity(ctx, { maxBytes: 1 << 20 }).entries.map(e => e.text)).toEqual(["last", "next", "first"]);
});

test("rotation keeps the newest 20 000 valid entries within 30 days and runs daily", () => {
  const ctx = fakeCtx();
  mkdirSync(join(ctx.pacerHome, "state"), { recursive: true });
  const entries = Array.from({ length: 20_050 }, (_, i) => JSON.stringify({ id: `${ctx.now}-${i.toString(16)}`, at: ctx.now, kind: "config", level: "info", text: String(i) }));
  entries.unshift(JSON.stringify({ id: "old-0000", at: ctx.now - 30 * 86400 - 1, kind: "config", level: "info", text: "old" }));
  writeFileSync(file(ctx), entries.join("\n") + "\n");
  rotateActivity(ctx);
  const lines = readFileSync(file(ctx), "utf8").trim().split("\n");
  expect(lines).toHaveLength(20_000);
  expect(JSON.parse(lines[0]!).text).toBe("50");
  expect(JSON.parse(lines.at(-1)!).text).toBe("20049");
  appendActivity(ctx, { kind: "config", level: "info", text: "new" });
  rotateActivity({ ...ctx, now: ctx.now + 1 });
  expect(readFileSync(file(ctx), "utf8").trim().split("\n")).toHaveLength(20_001);
  rotateActivity({ ...ctx, now: ctx.now + 86400 });
  expect(readFileSync(file(ctx), "utf8").trim().split("\n")).toHaveLength(20_000);
  expect(readActivity(ctx, { limit: 1000 }).entries).toHaveLength(500);
  expect(readActivity(ctx, {}).entries).toHaveLength(50);
});

const status = (now: number, usedPct = 20): Status => ({
  generatedAt: now, strategy: "default", planner: "claude-code", mode: "normal", disabled: false, calendarPace: false,
  providers: [{ id: "codex", account: "team", usage: "quota", verdict: "ON_PACE", installed: true, stale: false, windows: [], binding: null }],
  accounts: [{ name: "team", kind: "codex", verdict: "ON_PACE", usedPct, pacePct: null, resetsAt: null, window: "week", stale: false, source: null, capturedAt: now, runners: ["codex"], spendUsd: null }],
  executors: { ranked: [], excluded: [] },
});
const publish: PumpDeps["publish"] = async (ctx, events) => {
  let snapshot = readLatest(ctx);
  for (const e of events) snapshot = reduce(snapshot, e, ctx.now);
  writeJsonAtomic(latestPath(ctx), snapshot);
  return { seq: snapshot.seq, transports: ["outbox"], errors: [] };
};

test("budget refresh throttle is durable, per account, and expires at 15 minutes", async () => {
  const ctx = fakeCtx();
  for (const delta of [0, 300, 900]) {
    const current = { ...ctx, now: ctx.now + delta };
    await pumpOnce(current, { status: async () => status(current.now), tasks: () => [], publish });
    expect(readActivity(ctx, { kinds: ["budget_refreshed"] }).entries).toHaveLength(delta < 900 ? 1 : 2);
  }
});

test("activity.list validates filters and pages the log", async () => {
  const ctx = fakeCtx();
  appendActivity(ctx, { kind: "config", level: "info", text: "changed", repo: "demo" });
  expect(await callOp(ctx, "activity.list", { repo: "demo", kinds: ["config"] })).toMatchObject({ entries: [{ text: "changed" }], next: null });
  for (const params of [{ limit: 501 }, { limit: 0 }, { kinds: ["unknown"] }]) {
    expect(callOp(ctx, "activity.list", params)).rejects.toMatchObject({ code: "invalid_input" });
  }
});

test("pump logs settle, mode, executor and account changes once", async () => {
  const ctx = await configured();
  const task = tasks.delegate(ctx, { brief: { goal: "Add SSH keepalive", repo: ctx.home }, executor: "codex" }, () => 1);
  const deps: PumpDeps = { status: async c => status(c.now), tasks: () => [tasks.get(ctx, task.id)], publish };
  await pumpOnce(ctx, deps);
  updateTask(ctx, task.id, t => { t.state = "done"; t.executor = "codex"; });
  const next = { ...ctx, now: ctx.now + 1 };
  const changed: PumpDeps = { ...deps, status: async () => {
    const s = status(next.now);
    s.mode = "emergency";
    s.providers[0]!.blockedReason = "maintenance";
    s.accounts![0]!.verdict = "EXHAUSTED";
    return s;
  } };
  await pumpOnce(next, changed);
  await pumpOnce(next, changed);
  expect(readActivity(ctx, { kinds: ["task_settled"] }).entries).toMatchObject([
    { text: "Codex finished “Add SSH keepalive”", executor: "codex", taskId: task.id },
  ]);
  expect(readActivity(ctx, { kinds: ["mode"] }).entries.map(e => e.text)).toEqual(["Mode Normal → Emergency · planner out of quota"]);
  expect(readActivity(ctx, { kinds: ["executor_state"] }).entries.map(e => e.text)).toEqual(["Codex marked blocked · maintenance"]);
  expect(readActivity(ctx, { kinds: ["account_state"] }).entries).toHaveLength(1);
});

test("retry, stop, dismiss and rejected reviews log their successful actions", async () => {
  const ctx = await configured();
  const original = tasks.delegate(ctx, { brief: { goal: "Fix parser", repo: ctx.home }, executor: "codex" }, () => 1);
  updateTask(ctx, original.id, t => { t.state = "failed"; });
  const result = await tasks.retry(ctx, original.id, { executor: "codex" }, {
    delegate: (c, input) => tasks.delegate(c, input, () => 1),
  });
  expect(readActivity(ctx, { kinds: ["retry"] }).entries).toHaveLength(1);
  // Calling core.delegate as the retry dependency must not duplicate task_started.
  expect(readActivity(ctx, { kinds: ["task_started"] }).entries).toHaveLength(1);
  tasks.stop(ctx, result.retry.id);
  tasks.stop(ctx, result.retry.id);
  expect(readActivity(ctx, { kinds: ["task_settled"] }).entries.map(e => e.text)).toEqual(["Stopped “Fix parser”"]);
  tasks.review(ctx, original.id, { accepted: false });
  tasks.dismiss(ctx, [original.id, "unknown"]);
  expect(readActivity(ctx, { kinds: ["verdict"] }).entries.map(e => e.text)).toEqual(["Dismissed “Fix parser”", "Rejected “Fix parser”"]);
});

test("config writes record one entry without values or secrets", async () => {
  const ctx = await configured();
  await callOp(ctx, "config.set", { key: "pacing.planner_reserve", value: 15 });
  expect(readActivity(ctx, { kinds: ["config"] }).entries).toMatchObject([{ text: "Configuration changed · config" }]);
  expect(readActivity(ctx, { kinds: ["config"] }).entries).toHaveLength(1);
  await callOp(ctx, "host.add", { alias: "dev", ssh: "example.invalid" });
  expect(readActivity(ctx, { kinds: ["config"] }).entries).toHaveLength(2);
});

test("budget refresh throttles independently for accounts sharing multiple runners", async () => {
  const ctx = fakeCtx();
  const run = async (delta: number, addAccount = false) => {
    const current = { ...ctx, now: ctx.now + delta };
    const s = status(current.now);
    s.accounts![0]!.runners.push("opencode");
    if (addAccount) s.accounts!.push({ ...s.accounts![0]!, name: "other", runners: ["cursor"] });
    await pumpOnce(current, { status: async () => s, tasks: () => [], publish });
  };
  await run(0);
  await run(300, true);
  const refreshed = readActivity(ctx, { kinds: ["budget_refreshed"] }).entries;
  expect(refreshed).toHaveLength(2);
  expect(refreshed[0]!.text).toContain("Cursor 20%");
  expect(refreshed[0]!.text).not.toContain("Codex");
});


test("rotation removes entries older than 30 days even below the line cap", () => {
  const ctx = fakeCtx();
  appendActivity({ ...ctx, now: ctx.now - 30 * 86400 - 1 }, { kind: "config", level: "info", text: "expired" });
  appendActivity({ ...ctx, now: ctx.now - 30 * 86400 }, { kind: "config", level: "info", text: "boundary" });
  appendActivity(ctx, { kind: "config", level: "info", text: "today" });
  rotateActivity(ctx);
  expect(readActivity(ctx, {}).entries.map(e => e.text)).toEqual(["today", "boundary"]);
});

test("activity text redacts credential patterns and account emails before persistence and callback", () => {
  const ctx = fakeCtx(), observed: string[] = [];
  appendActivity(ctx, { kind: "executor_state", level: "warn", text: "Failed for person@example.com · token=private-value · Bearer sensitive" }, e => observed.push(e.text));
  const persisted = readFileSync(file(ctx), "utf8");
  for (const secret of ["person@example.com", "private-value", "sensitive"]) expect(persisted).not.toContain(secret);
  expect(observed).toEqual([readActivity(ctx, {}).entries[0]!.text]);
});

test("append publishes activity through the entity envelope and advertises it", async () => {
  const { eventsSince } = await import("../src/api/events");
  const { helloBody } = await import("../src/api/protocol");
  const ctx = fakeCtx();
  const entry = appendActivity(ctx, { kind: "config", level: "info", text: "Changed" });
  let events: ReturnType<typeof eventsSince>;
  for (let i = 0; i < 100; i++) {
    events = eventsSince(ctx, 0);
    if (events.events.some(e => e.type === "activity")) break;
    await Bun.sleep(10);
  }
  expect(events!.events).toContainEqual(expect.objectContaining({ type: "activity", data: entry }));
  expect(helloBody().events).toContain("activity");
});

test("budget refresh names only accounts with a runner and a reading", async () => {
  const ctx = fakeCtx();
  const s = status(ctx.now);
  s.accounts!.push({ ...s.accounts![0]!, name: "no-runner", runners: [] }, { ...s.accounts![0]!, name: "no-reading", runners: ["cursor"], usedPct: null });
  await pumpOnce(ctx, { status: async () => s, tasks: () => [], publish });
  for (const entry of readActivity(ctx, { kinds: ["budget_refreshed"] }).entries) expect(entry.text).not.toMatch(/unknown|the executor/);
});
