import { expect, test } from "bun:test";
import { join } from "node:path";
import { applyStore, dismissItem, snoozeItem } from "../src/attention/store";
import type { AttentionItem } from "../src/attention/types";
import { deriveItems } from "../src/attention/rules";
import { fakeCtx } from "./helpers";
import { capacityFixture } from "./read-model-helpers";
import { buildExecutors } from "../src/api/read-model/capacity";
import { readJson } from "../src/fsutil";

function fixture() {
 const ctx=fakeCtx(),{s,st}=capacityFixture();
 st.providers.find(p=>p.id==="codex")!.brokenReason="broken";
 const items=deriveItems({now:ctx.now,tasks:[],executors:buildExecutors(st,s,[],ctx.now),accounts:[],planner:null,setup:{complete:true,open:0,items:[]},update:null,retryTarget:()=>null});
 return {ctx,items};
}
test("first sight records now, keeps since and drops cleared occurrences",()=>{
 const {ctx,items}=fixture();
 const first=applyStore(ctx,items);
 expect(first[0]?.since).toBe(ctx.now);
 expect(applyStore({...ctx,now:ctx.now+10},items)[0]?.since).toBe(ctx.now);
 dismissItem(ctx,items[0]!.id,items);
 expect(applyStore(ctx,items)).toEqual([]);
 applyStore({...ctx,now:ctx.now+20},[]);
 expect(applyStore({...ctx,now:ctx.now+30},items)[0]?.since).toBe(ctx.now+30);
});
test("snooze expires exactly at its deadline",()=>{
 const {ctx,items}=fixture(),id=items[0]!.id;
 expect(snoozeItem(ctx,id,"1h",items)).toEqual({until:ctx.now+3600});
 expect(applyStore({...ctx,now:ctx.now+3599},items)).toEqual([]);
 expect(applyStore({...ctx,now:ctx.now+3600},items)).toHaveLength(1);
});
test("concurrent dismissals converge and unknown ids fail",async()=>{
 const {ctx,items}=fixture(),id=items[0]!.id;
 expect(await Promise.all([Promise.resolve().then(()=>dismissItem(ctx,id,items)),Promise.resolve().then(()=>dismissItem(ctx,id,items))])).toEqual([{dismissed:true},{dismissed:true}]);
 expect(readJson<Record<string,unknown>>(join(ctx.pacerHome,"state","attention.json"))?.[id]).toMatchObject({since:ctx.now,dismissedSince:ctx.now});
 expect(()=>dismissItem(ctx,"executor_down:missing",items)).toThrow();
});

test("condition item timestamps remain stable between pump evaluations",()=>{
 const {ctx,items}=fixture(),first=applyStore(ctx,items);
 expect(applyStore({...ctx,now:ctx.now+10},items.map(i=>({...i,raisedAt:ctx.now+10,since:ctx.now+10})))).toEqual(first);
});

test("a partial apply leaves unrelated entries (and their since) intact until a full prune",()=>{
 const {ctx}=fixture();
 // Two independent failed-task items sharing the store.
 const a: AttentionItem = {id:"failed:a",kind:"failed",severity:"problem",title:"A",detail:"a",repo:null,raisedAt:ctx.now,since:ctx.now,actions:[],notify:"all",taskId:"a"};
 const b: AttentionItem = {id:"failed:b",kind:"failed",severity:"problem",title:"B",detail:"b",repo:null,raisedAt:ctx.now,since:ctx.now,actions:[],notify:"all",taskId:"b"};
 // Full pass prunes and records both.
 expect(applyStore(ctx,[a,b])).toHaveLength(2);
 // Dismiss a, then a partial read covering only task b re-derives b.
 dismissItem(ctx,a.id,[a,b]);
 const partial=applyStore({...ctx,now:ctx.now+10},[b],new Set(["b"]));
 // The partial read must not resurrect a nor reset b's since.
 expect(partial.some(i=>i.id===a.id)).toBe(false);
 expect(partial).toHaveLength(1);
 // a stays dismissed in the store throughout; b keeps its original since until a full pass
 // covering every task can authoritatively decide whether a still applies.
 const full=applyStore({...ctx,now:ctx.now+20},[a,b]);
 expect(full.find(i=>i.id===b.id)!.since).toBe(ctx.now);
 expect(full.some(i=>i.id===a.id)).toBe(false);
});

test("a dismiss on an unrelated entry survives a partial apply scoped to another task",()=>{
 const {ctx}=fixture();
 const a: AttentionItem = {id:"failed:a",kind:"failed",severity:"problem",title:"A",detail:"a",repo:null,raisedAt:ctx.now,since:ctx.now,actions:[],notify:"all",taskId:"a"};
 const b: AttentionItem = {id:"failed:b",kind:"failed",severity:"problem",title:"B",detail:"b",repo:null,raisedAt:ctx.now,since:ctx.now,actions:[],notify:"all",taskId:"b"};
 applyStore(ctx,[a,b]);
 dismissItem(ctx,a.id,[a,b]); // user dismisses a
 // A partial pass only touches b and must leave a's dismissal intact in the store.
 applyStore({...ctx,now:ctx.now+10},[b],new Set(["b"]));
 const partialAgain=applyStore({...ctx,now:ctx.now+11},[b],new Set(["b"]));
 expect(partialAgain.some(i=>i.id===a.id)).toBe(false);
 // The same materialized via buildReadModel-style full input: a still hidden after full pass.
 const full=applyStore({...ctx,now:ctx.now+20},[a,b]);
 expect(full.some(i=>i.id===a.id)).toBe(false);
});

test("a covered task's stale dismissal is pruned on a partial apply so a follow-up is visible",()=>{
 const {ctx}=fixture();
 const q: AttentionItem = {id:"question:t",kind:"question",severity:"blocked",title:"Question",detail:"q",repo:null,raisedAt:ctx.now,since:ctx.now,actions:[],notify:"important",taskId:"t"};
 applyStore(ctx,[q]);
 dismissItem(ctx,q.id,[q]);
 // The task is answered: a partial read that covers t derives no question item.
 expect(applyStore({...ctx,now:ctx.now+10},[],new Set(["t"]))).toEqual([]);
 const store=readJson<Record<string,unknown>>(join(ctx.pacerHome,"state","attention.json"))!;
 expect(store[q.id]).toBeUndefined(); // stale dismissal is gone, not carried forward
 // A follow-up question gets a fresh entry instead of being hidden by the old dismissal.
 const followUp:AttentionItem={...q,title:"Follow-up",raisedAt:ctx.now+11,since:ctx.now+11};
 const out=applyStore({...ctx,now:ctx.now+11},[followUp],new Set(["t"]));
 expect(out).toHaveLength(1);
 expect(out[0]!.since).toBe(ctx.now+11);
});
