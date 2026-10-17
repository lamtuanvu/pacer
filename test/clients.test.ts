import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { activeNotifier, heartbeat, list, register } from "../src/clients/registry";
import { callOp, opNames } from "../src/api/ops";
import { fakeCtx } from "./helpers";

test("the newest live notifier wins, falling back when leases lapse", () => {
  const ctx = fakeCtx();
  expect(activeNotifier(ctx)).toBeNull();
  const a = register(ctx, { kind: "desktop", version: "1", notifier: true });
  ctx.now += 1;
  const b = register(ctx, { kind: "orca", version: "1", notifier: true });
  expect(activeNotifier(ctx)?.client_id).toBe(b.client_id);
  ctx.now += 30;
  heartbeat(ctx, a.client_id);
  ctx.now += 16;
  expect(activeNotifier(ctx)?.client_id).toBe(a.client_id);
  ctx.now += 30;
  expect(activeNotifier(ctx)).toBeNull();
});

test("heartbeat renews for 45 seconds without changing registration priority", () => {
  const ctx = fakeCtx();
  const a = register(ctx, { kind: "app", version: "1", notifier: true });
  const b = register(ctx, { kind: "tray", version: "1", notifier: true });
  ctx.now += 30;
  expect(heartbeat(ctx, a.client_id)).toEqual({ ok: true });
  expect(activeNotifier(ctx)?.client_id).toBe(b.client_id);
  ctx.now += 15;
  expect(activeNotifier(ctx)?.client_id).toBe(b.client_id);
  ctx.now += 1;
  expect(activeNotifier(ctx)?.client_id).toBe(a.client_id);
  ctx.now += 30;
  expect(activeNotifier(ctx)).toBeNull();
});

test("registrations persist under state and non-notifiers cannot take the lease", () => {
  const ctx = fakeCtx();
  expect(list(ctx)).toEqual([]);
  const a = register(ctx, { kind: "desktop", version: "2", notifier: true });
  expect(a).toEqual({ client_id: expect.any(String), lease_s: 30 });
  const b = register(ctx, { kind: "cli", version: "3" });
  expect(b.client_id).not.toBe(a.client_id);
  const restored = fakeCtx({ pacerHome: ctx.pacerHome, now: ctx.now });
  expect(activeNotifier(restored)?.client_id).toBe(a.client_id);
  expect(list(restored)).toEqual(expect.arrayContaining([
    expect.objectContaining({ client_id: a.client_id, kind: "desktop", version: "2", notifier: true }),
    expect.objectContaining({ client_id: b.client_id, kind: "cli", version: "3", notifier: false }),
  ]));
  expect(JSON.parse(readFileSync(join(ctx.pacerHome, "state", "clients.json"), "utf8"))).toHaveLength(2);
  restored.now += 46;
  expect(list(restored)).toEqual([]);
  expect(activeNotifier(restored)).toBeNull();
  expect(heartbeat(restored, a.client_id)).toEqual({ ok: true });
  expect(activeNotifier(restored)?.client_id).toBe(a.client_id);
});

test("unknown heartbeat ids fail without creating state", () => {
  const ctx = fakeCtx();
  expect(() => heartbeat(ctx, "missing")).toThrow(expect.objectContaining({ code: "invalid_input" }));
  expect(list(ctx)).toEqual([]);
});

test("client operations advertise, register, renew and list clients", async () => {
  const ctx = fakeCtx();
  expect(opNames()).toEqual(expect.arrayContaining(["client.register", "client.heartbeat", "client.list"]));
  for (const kind of ["app", "desktop", "orca", "tui", "status", "tray", "cli"]) {
    const result = await callOp(ctx, "client.register", { kind, version: "1", notifier: true }) as { client_id: string; lease_s: number };
    expect(result.lease_s).toBe(30);
    expect(await callOp(ctx, "client.heartbeat", { client_id: result.client_id })).toEqual({ ok: true });
  }
  expect(await callOp(ctx, "client.list", {})).toHaveLength(7);
  ctx.now += 46;
  expect(await callOp(ctx, "client.list", {})).toEqual([]);
});

test("client operations reject invalid parameters and unknown ids", async () => {
  const ctx = fakeCtx();
  for (const params of [
    { kind: "unknown", version: "1" }, { kind: "app" },
    { kind: "app", version: "" }, { kind: "app", version: "1", notifier: "true" },
  ]) {
    await expect(callOp(ctx, "client.register", params)).rejects.toMatchObject({ code: "invalid_input" });
  }
  await expect(callOp(ctx, "client.heartbeat", { client_id: "missing" })).rejects.toMatchObject({ code: "invalid_input" });
  await expect(callOp(ctx, "client.heartbeat", { client_id: "" })).rejects.toMatchObject({ code: "invalid_input" });
});

test("snapshot service exposes only the live notifier identity", async()=>{
 const {buildReadModel}=await import("../src/api/read-model");
 const {capacityFixture}=await import("./read-model-helpers");
 const ctx=fakeCtx(),{s,st}=capacityFixture();
 const model=()=>buildReadModel(ctx,{status:st,strategy:s,tasks:[],setup:{checkedAt:ctx.now,complete:true,items:[]},hosts:[]});
 expect(model().service).toHaveProperty("notifier",null);
 const a=register(ctx,{kind:"orca",version:"1",notifier:true});
 expect(model().service).toHaveProperty("notifier",{client_id:a.client_id,kind:"orca"});
 ctx.now+=46;
 expect(model().service).toHaveProperty("notifier",null);
});
