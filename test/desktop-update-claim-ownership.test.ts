import {expect,test} from "bun:test";
import {fakeCtx} from "./helpers";
import {beginWorkSync,claimWorkSync,finishWorkSync} from "../src/update/desktop/admission";

test("claim reports first durable ownership separately from a same-incarnation active re-claim",()=>{
 const ctx=fakeCtx(),a=beginWorkSync(ctx,{kind:"task",id:"a",label:"A"}),b=beginWorkSync(ctx,{kind:"task",id:"b",label:"B"});
 try {expect(claimWorkSync(ctx,a)).toBe(true);expect(claimWorkSync(ctx,a)).toBe(false);expect(claimWorkSync(ctx,b)).toBe(true);}
 finally {finishWorkSync(ctx,a);finishWorkSync(ctx,b);}
});
