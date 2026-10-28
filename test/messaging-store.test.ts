// test/messaging-store.test.ts
import { expect, test } from "bun:test";
import { fakeCtx } from "./helpers";
import * as store from "../src/messaging/store";

const base = { taskId: "t-20261028-120000-aaaa", rootId: "task:t-20261028-120000-aaaa", from: "external:claude-code", to: "task:t-20261028-120000-aaaa", kind: "message" as const, body: "hi", replyTo: null, requestId: null };

test("insert is idempotent per sender and request id", () => {
  const ctx = fakeCtx();
  const a = store.insertMessage(ctx, { ...base, requestId: "r1" });
  const b = store.insertMessage(ctx, { ...base, requestId: "r1", body: "different" });
  expect(b.duplicate).toBe(true);
  expect(b.message.id).toBe(a.message.id);
  expect(store.thread(ctx, base.taskId).length).toBe(1);
});

test("claim, release and read lifecycle", () => {
  const ctx = fakeCtx();
  const m1 = store.insertMessage(ctx, base).message;
  const held = store.insertMessage(ctx, { ...base, status: "held" }).message;
  expect(store.pendingFor(ctx, base.to).map(m => m.id)).toEqual([m1.id]);
  const claimed = store.claimPending(ctx, base.to, "turn-1");
  expect(claimed.map(m => m.status)).toEqual(["delivered"]);
  expect(store.pendingFor(ctx, base.to)).toEqual([]);
  expect(store.releaseTurn(ctx, "turn-1")).toBe(1);
  expect(store.pendingFor(ctx, base.to).length).toBe(1);
  store.confirmHeld(ctx, held.id);
  expect(store.pendingFor(ctx, base.to).length).toBe(2);
  expect(store.markRead(ctx, base.to, [m1.id])).toBe(1);
  expect(store.inbox(ctx, base.to, { unreadOnly: true }).map(m => m.id)).toEqual([held.id]);
});

test("turn counting per root", () => {
  const ctx = fakeCtx();
  store.recordTurn(ctx, { id: "x#1", taskId: base.taskId, rootId: base.rootId, at: 1 });
  store.recordTurn(ctx, { id: "x#2", taskId: base.taskId, rootId: base.rootId, at: 2 });
  store.recordTurn(ctx, { id: "x#2", taskId: base.taskId, rootId: base.rootId, at: 2 });
  expect(store.turnsForRoot(ctx, base.rootId)).toBe(2);
});
