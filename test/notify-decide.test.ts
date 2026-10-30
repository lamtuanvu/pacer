import { expect, test, spyOn } from "bun:test";
import { join } from "node:path";
import { toNotify, dispatchNotifications } from "../src/notify/decide";
import type { AttentionItem } from "../src/attention/types";
import { register } from "../src/clients/registry";
import { readJson, writeJsonAtomic } from "../src/fsutil";
import { eventsSince } from "../src/api/events";
import { publish } from "../src/link/publish";
import { fakeCtx } from "./helpers";
import { pluginRegistry, shutdownPlugins } from "../src/plugins";
import * as pluginHost from "../src/plugins/host";

const item = (extra: Partial<AttentionItem> = {}): AttentionItem => ({ id:"failed:t-1",kind:"failed",severity:"problem",repo:null,taskId:"t-1",title:'Failed "task"\\\n',detail:"Try again",raisedAt:100,since:100,actions:[],notify:"important",...extra });

test("levels filter attention and keys include since with at most two actions", () => {
 const failed=item({actions:[1,2,3].map(n=>({label:`Action ${n}`,op:"task.retry",params:{}}))}), setup=item({id:"setup",kind:"setup",notify:"all",taskId:undefined});
 expect(toNotify([setup,failed],"off",{})).toEqual([]);
 expect(toNotify([setup,failed],"important",{})).toEqual([{key:"failed:t-1:100",data:{key:"failed:t-1:100",title:failed.title,body:"Try again",actions:failed.actions.slice(0,2),url:"/app/#/tasks/t-1"}}]);
 expect(toNotify([setup,failed],"all",{})).toHaveLength(2);
 expect(toNotify([failed,failed],"important",{})).toHaveLength(1);
 expect(toNotify([failed],"important",{"failed:t-1:100":101})).toEqual([]);
 expect(toNotify([item({since:102})],"important",{"failed:t-1:100":101})).toHaveLength(1);
});

test("a durable targeted event stays delivered after the notifier lease lapses", async () => {
 const ctx=fakeCtx(), notifier=register(ctx,{kind:"orca",version:"1",notifier:true});let fallback=0;
 const deps={publish:(c:typeof ctx,e:Parameters<typeof publish>[1])=>publish(c,e),notifiers:["pacer-notify"],deliver:async()=>{fallback++;return true;}};
 await dispatchNotifications(ctx,[item()],deps);
 expect(eventsSince(ctx,0).events).toEqual([expect.objectContaining({type:"notify",data:expect.objectContaining({client_id:notifier.client_id,key:"failed:t-1:100",title:item().title})})]);
 ctx.now+=46;
 await dispatchNotifications(ctx,[item()],deps);
 expect(fallback).toBe(0);
 expect(eventsSince(ctx,0).events).toHaveLength(1);
});

test("plugin delivery retries failures, deduplicates concurrent dispatch and prunes old ledger entries", async () => {
 const ctx=fakeCtx();let calls=0,success=false;
 writeJsonAtomic(join(ctx.pacerHome,"state/notified.json"),{old:ctx.now-7*86400-1});
 const deps={notifiers:["pacer-notify"],deliver:async(_id:string,data:{title:string;body:string})=>{expect(data.title).toBe(item().title);expect(data.body).toBe("Try again");calls++;return success;}};
 await dispatchNotifications(ctx,[item()],deps);
 expect(readJson<Record<string,number>>(join(ctx.pacerHome,"state/notified.json"))).toEqual({});
 success=true;
 await Promise.all([dispatchNotifications(ctx,[item()],deps),dispatchNotifications(ctx,[item()],deps)]);
 expect(calls).toBe(2);
 expect(readJson<Record<string,number>>(join(ctx.pacerHome,"state/notified.json"))).toEqual({"failed:t-1:100":ctx.now});
});

test("failed publication remains eligible for delivery", async()=>{
 const ctx=fakeCtx();register(ctx,{kind:"app",version:"1",notifier:true});
 await dispatchNotifications(ctx,[item()],{publish:async()=>({seq:0,transports:[],errors:["offline"]})});
 expect(toNotify([item()],"important",readJson<Record<string,number>>(join(ctx.pacerHome,"state/notified.json"))??{})).toHaveLength(1);
});

test("all includes mode transitions and every settled state while important excludes them", async()=>{
 const {setLevel}=await import("../src/core/notify");
 const ctx=fakeCtx(),shown:string[]=[];
 const events:import("../src/link/envelope").OutboxEvent[]=[{type:"mode",data:{mode:"strict",previous:"normal",strategy:"s",at:ctx.now}},...["done","partial","failed","limit","stopped"].map(state=>({type:"task" as const,data:{id:state,state,goal:state,executor:null,backend:null,worktree:null,updatedAt:ctx.now}}))];
 const deps={events,notifiers:["pacer-notify"],deliver:async(_id:string,data:{title:string})=>{shown.push(data.title);return true;}};
 await dispatchNotifications(ctx,[],deps);expect(shown).toEqual([]);
 setLevel(ctx,"all");
 await dispatchNotifications(ctx,[],deps);
 expect(shown).toEqual(["Budget mode changed to strict","Task done","Task partial","Task failed","Task limit","Task stopped"]);
 await dispatchNotifications(ctx,[],deps);expect(shown).toHaveLength(6);
});

test("notification links target review, sessions and settings directly", () => {
 for (const [extra, route] of [
  [{kind:"review",taskId:"a b"}, "tasks/a%20b"],
  [{kind:"stuck"}, "tasks/t-1"],
  [{taskId:undefined,executor:"codex"}, "settings/executors"],
  [{taskId:undefined,account:"work"}, "settings/accounts"],
  [{taskId:undefined,host:"box"}, "settings/hosts/box"],
  [{taskId:undefined}, ""],
  [{taskId:undefined,executor:"planner",actions:[{label:"Planner",op:"ui.open",params:{view:"settings",section:"planner"}}]}, "settings/planner"],
  [{kind:"update",taskId:undefined}, "settings/updates"],
 ] satisfies [Partial<AttentionItem>, string][]) expect(toNotify([item(extra)],"all",{})[0]?.data.url).toBe(`/app/#/${route}`);
});

test("settled task notifications link to review only until the result is reviewed", async () => {
 const {setLevel}=await import("../src/core/notify");
 const ctx=fakeCtx();
 register(ctx,{kind:"app",version:"1",notifier:true});
 setLevel(ctx,"all");
 const base={goal:"Task",executor:null,backend:null,worktree:null,updatedAt:ctx.now};
 const result=await dispatchNotifications(ctx,[],{events:[
  {type:"mode",data:{mode:"strict",previous:"normal",strategy:"s",at:ctx.now}},
  {type:"task",data:{...base,id:"done",state:"done"}},
  {type:"task",data:{...base,id:"partial",state:"partial"}},
  {type:"task",data:{...base,id:"accepted",state:"done",review:{accepted:true,at:ctx.now,kind:null,note:null}}},
  {type:"task",data:{...base,id:"failed",state:"failed"}},
 ]});
 expect(result.map(e=>(e.data as any).value.url)).toEqual([
  "/app/#/", "/app/#/tasks/done", "/app/#/tasks/partial", "/app/#/tasks/accepted", "/app/#/tasks/failed",
 ]);
});


test("notifier providers run in id order, continue after errors/false and stop only on true", async () => {
  const ctx = fakeCtx(), asked: string[] = [];
  const result = await dispatchNotifications(ctx, [item()], {
    notifiers: ["z-unused", "c-delivered", "b-false", "a-error"],
    deliver: async (id, data) => { asked.push(`${id}:${data.key}`); if (id === "a-error") throw Error("owned provider failure"); return id === "c-delivered"; },
  });
  expect(asked).toEqual(["a-error:failed:t-1:100", "b-false:failed:t-1:100", "c-delivered:failed:t-1:100"]);
  expect(result).toEqual([]);
  expect(readJson(join(ctx.pacerHome, "state/notified.json"))).toEqual({ "failed:t-1:100": ctx.now });
});

test("malformed injected delivery values never mark the ledger", async () => {
  const ctx = fakeCtx();
  await dispatchNotifications(ctx, [item()], { notifiers: ["bad"], deliver: async () => "true" as unknown as boolean });
  expect(readJson(join(ctx.pacerHome, "state/notified.json"))).toEqual({});
});

test("provider log failure cannot escape or prevent the next provider", async () => {
  const ctx = fakeCtx(), asked: string[] = [];
  const log = spyOn(pluginHost, "appendPluginLog").mockImplementation(() => { throw Error("owned log failure"); });
  try {
    await dispatchNotifications(ctx, [item()], { notifiers: ["first", "second"], deliver: async id => {
      asked.push(id); if (id === "first") throw Error("private provider detail"); return true;
    } });
    expect(asked).toEqual(["first", "second"]);
    expect(readJson(join(ctx.pacerHome, "state/notified.json"))).toEqual({ "failed:t-1:100": ctx.now });
  } finally { log.mockRestore(); }
});

test("registered-client publication failure never tries notifier plugins", async () => {
  const ctx = fakeCtx(); register(ctx, { kind: "app", version: "1", notifier: true });
  let plugins = 0;
  const deps = { notifiers: ["pacer-notify"], deliver: async () => { plugins++; return true; } };
  await dispatchNotifications(ctx, [item()], { ...deps, publish: async () => ({ seq: 0, transports: [], errors: ["offline"] }) });
  expect(plugins).toBe(0);
  expect(readJson(join(ctx.pacerHome, "state/notified.json"))).toEqual({});
  await expect(dispatchNotifications(ctx, [item()], { ...deps, publish: async () => { throw Error("owned publication failure"); } })).rejects.toThrow("owned publication failure");
  expect(plugins).toBe(0);
});

test("default registry delivery validates the result boolean and sends only notifier message fields", async () => {
  const ctx = fakeCtx(), registry = pluginRegistry(ctx), received: { id: string; method: string; data: any; options: any }[] = [];
  const call = spyOn(registry, "call").mockImplementation(async (_ctx, id, method, data, options) => {
    received.push({ id, method, data, options });
    return (id === "first" ? { delivered: "yes" } : { delivered: true }) as any;
  });
  try {
    await dispatchNotifications(ctx, [item()], { notifiers: ["second", "first"] });
    expect(received.map(request => request.id)).toEqual(["first", "second"]);
    expect(received[0]!.method).toBe("notifier.deliver");
    expect(received[0]!.data).toEqual({ key: "failed:t-1:100", title: item().title, body: "Try again", url: "/app/#/tasks/t-1" });
    expect(received[0]!.options.deadlineMs).toBe(5000);
    expect(received[0]!.options.resources.commands[0]!.timeoutMs).toBe(5000);
    expect(readJson(join(ctx.pacerHome, "state/notified.json"))).toEqual({ "failed:t-1:100": ctx.now });
  } finally { call.mockRestore(); await shutdownPlugins(ctx); }
});


test("empty notifier discovery leaves delivery eligible", async () => {
  const ctx = fakeCtx();
  let calls = 0;
  expect(await dispatchNotifications(ctx, [item()], { notifiers: [], deliver: async () => { calls++; return true; } })).toEqual([]);
  expect(calls).toBe(0);
  expect(readJson(join(ctx.pacerHome, "state/notified.json"))).toEqual({});
});

test("notifier discovery failure leaves delivery eligible without escaping", async () => {
  const ctx = fakeCtx(), registry = pluginRegistry(ctx);
  const find = spyOn(registry, "findAll").mockImplementation(() => { throw Error("owned discovery failure"); });
  try {
    expect(await dispatchNotifications(ctx, [item()])).toEqual([]);
    expect(readJson(join(ctx.pacerHome, "state/notified.json"))).toEqual({});
  } finally { find.mockRestore(); await shutdownPlugins(ctx); }
});

test("notifier order uses locale-independent identifier sorting", async () => {
  const ctx = fakeCtx(), asked: string[] = [];
  await dispatchNotifications(ctx, [item()], { notifiers: ["a0", "a-b", "aa"], deliver: async id => { asked.push(id); return false; } });
  expect(asked).toEqual(["a-b", "a0", "aa"]);
});

test("oversize attention text is clipped to the notifier protocol bounds and delivered once (F9)", async () => {
 const ctx=fakeCtx();const seen:{title:string;body:string}[]=[];
 const long=item({title:"T".repeat(400),detail:"B".repeat(3000)});
 const deps={notifiers:["pacer-notify"],deliver:async(_id:string,data:{title:string;body:string})=>{seen.push(data);return true;}};
 await dispatchNotifications(ctx,[long],deps);await dispatchNotifications(ctx,[long],deps);
 expect(seen).toHaveLength(1);expect(seen[0]!.title.length).toBe(256);expect(seen[0]!.body.length).toBe(2048);expect(seen[0]!.title.endsWith("…")).toBe(true);
});
