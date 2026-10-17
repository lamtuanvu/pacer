import { expect, test } from "bun:test";
import { join } from "node:path";
import { applyStore, dismissItem, snoozeItem } from "../src/attention/store";
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
