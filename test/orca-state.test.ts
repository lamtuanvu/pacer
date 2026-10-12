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
  expect(loadOrcaState(ctx)).toEqual({ coordinator: null, run: null, workers: {} });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(orcaStatePath(ctx), "not json");
  expect(loadOrcaState(ctx)).toEqual({ coordinator: null, run: null, workers: {} });
});

test("updateOrcaState persists coordinator, run and workers", () => {
  const ctx = fakeCtx();
  updateOrcaState(ctx, (s) => {
    s.coordinator = "term_1";
    s.run = "run_1";
    s.workers.ctx_1 = { dispatchId: "ctx_1", taskId: "t-20261011-150000-ab12", executor: "codex", worktree: "/wt", terminal: "term_2", startedAt: 5 };
  });
  expect(loadOrcaState(ctx)).toEqual({
    coordinator: "term_1", run: "run_1",
    workers: { ctx_1: { dispatchId: "ctx_1", taskId: "t-20261011-150000-ab12", executor: "codex", worktree: "/wt", terminal: "term_2", startedAt: 5 } },
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
