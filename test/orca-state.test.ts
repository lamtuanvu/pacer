import { expect, test } from "bun:test";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type InboxEntry, hasInbox, inboxDir, loadOrcaState, orcaStatePath, putInbox, takeInbox, updateOrcaState, withLock,
} from "../src/exec/orca/state";
import { fakeCtx } from "./helpers";

const entry = (subject: string): InboxEntry => ({ outcome: "succeeded", subject, body: "b", filesModified: ["a.ts"], messageId: "msg_1" });

test("a missing or corrupt orca.json loads as empty state", () => {
  const ctx = fakeCtx();
  expect(loadOrcaState(ctx)).toEqual({ coordinator: null, run: null, workers: {}, stranded: {}, uncertain: {}, unclosed: {}, strays: {}, removed: {}, groups: {} });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(orcaStatePath(ctx), "not json");
  expect(loadOrcaState(ctx)).toEqual({ coordinator: null, run: null, workers: {}, stranded: {}, uncertain: {}, unclosed: {}, strays: {}, removed: {}, groups: {} });
});

test("updateOrcaState persists coordinator, run and workers", () => {
  const ctx = fakeCtx();
  updateOrcaState(ctx, (s) => {
    s.coordinator = "term_1";
    s.run = "run_1";
    s.workers.ctx_1 = { dispatchId: "ctx_1", taskId: "t-20261011-150000-ab12", executor: "codex", worktree: "/wt", terminal: "term_2", startedAt: 5 };
  });
  expect(loadOrcaState(ctx)).toEqual({
    coordinator: "term_1", run: "run_1", stranded: {}, uncertain: {}, unclosed: {}, strays: {}, removed: {},
    workers: { ctx_1: { dispatchId: "ctx_1", taskId: "t-20261011-150000-ab12", executor: "codex", worktree: "/wt", terminal: "term_2", startedAt: 5 } },
    groups: {},
  });
  updateOrcaState(ctx, (s) => { delete s.workers.ctx_1; });
  expect(loadOrcaState(ctx).workers).toEqual({});
});

test("inbox: first worker_done wins, take removes it, unsafe ids are ignored", () => {
  const ctx = fakeCtx();
  putInbox(ctx, "ctx_28ca2bdd914b", entry("first"));
  putInbox(ctx, "ctx_28ca2bdd914b", entry("second"));
  expect(hasInbox(ctx, "ctx_28ca2bdd914b")).toBe(true);
  expect(takeInbox(ctx, "ctx_28ca2bdd914b")?.subject).toBe("first");
  expect(hasInbox(ctx, "ctx_28ca2bdd914b")).toBe(false);
  expect(takeInbox(ctx, "ctx_28ca2bdd914b")).toBeNull();
  putInbox(ctx, "../escape", entry("x"));
  expect(hasInbox(ctx, "../escape")).toBe(false);
  expect(existsSync(join(inboxDir(ctx), "..", "escape.json"))).toBe(false);
});

test("withLock runs callers one at a time", async () => {
  const ctx = fakeCtx();
  const order: string[] = [];
  const job = (n: string) => withLock(ctx, "t", async () => {
    order.push(`${n}+`);
    await Bun.sleep(30);
    order.push(`${n}-`);
    return n;
  });
  expect(await Promise.all([job("a"), job("b")])).toEqual(["a", "b"]);
  expect(order).toEqual(["a+", "a-", "b+", "b-"]);
  expect(existsSync(join(ctx.pacerHome, "orca", "t.lock"))).toBe(false);
});

test("a stale lock is taken over; a held lock times out with an error", async () => {
  const ctx = fakeCtx();
  const lock = join(ctx.pacerHome, "orca", "t.lock");
  mkdirSync(join(ctx.pacerHome, "orca"), { recursive: true });
  writeFileSync(lock, "");
  const old = Date.now() / 1000 - 3600;
  utimesSync(lock, old, old);
  expect(await withLock(ctx, "t", async () => "ok", { staleMs: 1000 })).toBe("ok");
  writeFileSync(lock, "");
  await expect(withLock(ctx, "t", async () => "never", { timeoutMs: 120 })).rejects.toThrow("timed out");
});

test("stranded worktrees, uncertain starts, stray risks and removals persist; malformed records are dropped", () => {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(orcaStatePath(ctx), JSON.stringify({
    stranded: { t1: { taskId: "t1", id: "r::/w", path: "/w", name: "pacer-t1-codex", at: 1 }, bad: { taskId: 3 } },
    uncertain: { term_a: { taskId: "t1", terminal: "term_a", run: "run_1", worktree: null, at: 1 }, term_b: "x" },
    strays: { "r::/w": { taskId: "t1", id: "r::/w", path: "/w", name: "pacer-t1-codex", initial: ["term_a", 3], at: 1 }, "r::/old": { taskId: "t1", id: "r::/old", path: "/old", name: "pacer-t1-codex", at: 1 }, bad: { id: 3 } },
    removed: { "r::/w": { id: "r::/w", path: "/w", at: 1 }, bad: { id: "r::/x" } },
  }));
  const s = loadOrcaState(ctx);
  expect(Object.keys(s.stranded)).toEqual(["t1"]);
  expect(Object.keys(s.uncertain)).toEqual(["term_a"]);
  expect(Object.keys(s.strays)).toEqual(["r::/w", "r::/old"]);
  expect([s.strays["r::/w"]!.initial, s.strays["r::/old"]!.initial]).toEqual([["term_a"], []]);
  expect(Object.keys(s.removed)).toEqual(["r::/w"]);
});

test("group cache entries without a path selector are dropped on load", () => {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(orcaStatePath(ctx), JSON.stringify({ groups: { "r:ok": { selector: "path:/work/g" }, "r:id": { selector: "id:other" }, "r:bad": { selector: 7 }, "r:junk": "x" } }));
  expect(loadOrcaState(ctx).groups).toEqual({ "r:ok": { selector: "path:/work/g" } });
});
