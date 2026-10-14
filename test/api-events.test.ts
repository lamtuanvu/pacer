import { expect, test } from "bun:test";
import { apiSnapshot, eventsSince } from "../src/api/events";
import { publish } from "../src/link/publish";
import { appendOutbox } from "../src/link/store";
import { fakeCtx } from "./helpers";

const alert = (key: string, at: number) => ({ v: 1 as const, type: "alert" as const, data: { key, level: "info" as const, title: key, body: "", at } });

test("events after a seq, in order, with their envelope type and data", async () => {
  const ctx = fakeCtx();
  await publish(ctx, [alert("a", ctx.now), alert("b", ctx.now)], { bridge: false, channel: false });
  const all = eventsSince(ctx, 0);
  expect(all.events.map((e) => [e.type, (e.data as { key: string }).key])).toEqual([["alert", "a"], ["alert", "b"]]);
  expect(all.reset).toBe(false);
  const later = eventsSince(ctx, all.events[0].seq);
  expect(later.events.map((e) => (e.data as { key: string }).key)).toEqual(["b"]);
  expect(later.last).toBe(all.last);
});

test("a since older than the retained outbox yields reset", () => {
  const ctx = fakeCtx();
  appendOutbox(ctx, [{ seq: 50, envelope: alert("x", ctx.now) }, { seq: 51, envelope: alert("y", ctx.now) }]);
  const r = eventsSince(ctx, 10);
  expect(r.reset).toBe(true);
  expect(r.events[0]).toMatchObject({ type: "reset", seq: 49 });
  expect(r.events.slice(1).map((e) => e.seq)).toEqual([50, 51]);
});

test("the snapshot carries the protocol version and its seq", async () => {
  const ctx = fakeCtx();
  await publish(ctx, [alert("a", ctx.now)], { bridge: false, channel: false });
  expect(apiSnapshot(ctx)).toMatchObject({ protocol: "2.0.0", seq: eventsSince(ctx, 0).last });
});
