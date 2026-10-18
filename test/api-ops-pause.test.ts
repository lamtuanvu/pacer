import { expect, test } from "bun:test";
import { callOp } from "../src/api/ops";
import { eventsSince } from "../src/api/events";
import { helloBody } from "../src/api/protocol";
import { readPause } from "../src/core/pause";
import { pumpOnce, type PumpDeps } from "../src/link/pump";
import { publish } from "../src/link/publish";
import { fakeCtx } from "./helpers";

const pauseEvents = (ctx: ReturnType<typeof fakeCtx>) => eventsSince(ctx, 0).events.filter(e => e.type === "pause");
const deps: PumpDeps = {status: async () => {throw new Error("provider unavailable");}, tasks: () => [], publish};

test("pause and resume publish state directly to API clients", async () => {
  const ctx = fakeCtx();
  const state = await callOp(ctx, "delegation.pause", {for:"1m", reason:"Review work"});
  expect(state).toEqual({until:ctx.now+60, reason:"Review work", by:null});
  expect(pauseEvents(ctx).map(e => e.data)).toEqual([state]);
  expect(helloBody().events).toContain("pause");
  await callOp(ctx, "delegation.resume", {});
  expect(pauseEvents(ctx).map(e => e.data)).toEqual([state, {removed:true}]);
  await pumpOnce({...ctx, now:ctx.now+60}, deps);
  expect(pauseEvents(ctx)).toHaveLength(2);
});

test("timed pause expiry publishes removed once, even when status refresh fails", async () => {
  const ctx = fakeCtx();
  await callOp(ctx, "delegation.pause", {for:"1m"});
  await pumpOnce({...ctx, now:ctx.now+59}, deps);
  expect(pauseEvents(ctx)).toHaveLength(1);
  const expired = {...ctx, now:ctx.now+60};
  expect(await pumpOnce(expired, deps)).toContainEqual({v:1,type:"pause",data:{removed:true}});
  await pumpOnce({...expired, now:expired.now+1}, deps);
  expect(pauseEvents(ctx).map(e => e.data)).toEqual([{until:ctx.now+60, reason:null, by:null}, {removed:true}]);
  expect(readPause(ctx)).toBeNull();
});

test("expiry retries publication if the outbox is unavailable", async () => {
  const ctx = fakeCtx();
  await callOp(ctx, "delegation.pause", {for:"1m"});
  const expired = {...ctx, now:ctx.now+60};
  await pumpOnce(expired, {...deps, publish:async () => ({seq:0,transports:[],errors:["unavailable"]})});
  await pumpOnce(expired, deps);
  await pumpOnce(expired, deps);
  expect(pauseEvents(ctx).filter(e => (e.data as {removed?:boolean}).removed)).toHaveLength(1);
});
