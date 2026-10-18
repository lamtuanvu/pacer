import { expect, test } from "bun:test";
import { join } from "node:path";
import { toNotify, dispatchNotifications } from "../src/notify/decide";
import type { AttentionItem } from "../src/attention/types";
import { register } from "../src/clients/registry";
import { readJson, writeJsonAtomic } from "../src/fsutil";
import { eventsSince } from "../src/api/events";
import { publish } from "../src/link/publish";
import { fakeCtx } from "./helpers";

const item = (extra: Partial<AttentionItem> = {}): AttentionItem => ({ id:"failed:t-1",kind:"failed",severity:"problem",repo:null,taskId:"t-1",title:'Failed "task"\\\n',detail:"Try again",raisedAt:100,since:100,actions:[],notify:"important",...extra });

test("levels filter attention and keys include since with at most two actions", () => {
 const failed=item({actions:[1,2,3].map(n=>({label:`Action ${n}`,op:"task.retry",params:{}}))}), setup=item({id:"setup",kind:"setup",notify:"all",taskId:undefined});
 expect(toNotify([setup,failed],"off",{})).toEqual([]);
 expect(toNotify([setup,failed],"important",{})).toEqual([{key:"failed:t-1:100",data:{key:"failed:t-1:100",title:failed.title,body:"Try again",actions:failed.actions.slice(0,2),url:"/app/#/sessions/t-1"}}]);
 expect(toNotify([setup,failed],"all",{})).toHaveLength(2);
 expect(toNotify([failed,failed],"important",{})).toHaveLength(1);
 expect(toNotify([failed],"important",{"failed:t-1:100":101})).toEqual([]);
 expect(toNotify([item({since:102})],"important",{"failed:t-1:100":101})).toHaveLength(1);
});

test("a durable targeted event stays delivered after the notifier lease lapses", async () => {
 const ctx=fakeCtx(), notifier=register(ctx,{kind:"orca",version:"1",notifier:true});let fallback=0;
 const deps={publish:(c:typeof ctx,e:Parameters<typeof publish>[1])=>publish(c,e),postFallback:async()=>{fallback++;return true;}};
 await dispatchNotifications(ctx,[item()],deps);
 expect(eventsSince(ctx,0).events).toEqual([expect.objectContaining({type:"notify",data:expect.objectContaining({client_id:notifier.client_id,key:"failed:t-1:100",title:item().title})})]);
 ctx.now+=46;
 await dispatchNotifications(ctx,[item()],deps);
 expect(fallback).toBe(0);
 expect(eventsSince(ctx,0).events).toHaveLength(1);
});

test("fallback retries failures, deduplicates concurrent dispatch and prunes old ledger entries", async () => {
 const ctx=fakeCtx();let calls=0,success=false;
 writeJsonAtomic(join(ctx.pacerHome,"state/notified.json"),{old:ctx.now-7*86400-1});
 const deps={postFallback:async(title:string,body:string)=>{expect(title).toBe(item().title);expect(body).toBe("Try again");calls++;return success;}};
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
 const deps={events,postFallback:async(title:string)=>{shown.push(title);return true;}};
 await dispatchNotifications(ctx,[],deps);expect(shown).toEqual([]);
 setLevel(ctx,"all");
 await dispatchNotifications(ctx,[],deps);
 expect(shown).toEqual(["Budget mode changed to strict","Task done","Task partial","Task failed","Task limit","Task stopped"]);
 await dispatchNotifications(ctx,[],deps);expect(shown).toHaveLength(6);
});

test("notification links target review, sessions and settings directly", () => {
 for (const [extra, route] of [
  [{kind:"review",taskId:"a b"}, "review/a%20b"],
  [{kind:"stuck"}, "sessions/t-1"],
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
  "/app/#/", "/app/#/review/done", "/app/#/review/partial", "/app/#/sessions/accepted", "/app/#/sessions/failed",
 ]);
});
