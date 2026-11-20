import {expect,test} from "bun:test";
import {executorCommand} from "../src/executors/command";
import {readBlocked,blockExecutor} from "../src/executors/blocked";
import {validateStrategy} from "../src/config/strategy";
import {computeStatus} from "../src/engine/status";
import {delegate} from "../src/tasks/api";
import {renderLine} from "../src/render/line";
import {fakeCtx,withLoginIndicators} from "./helpers";
const strategy=validateStrategy({planner:"claude-code",providers:{"claude-code":{usage:"reactive"},agy:{usage:"reactive"},codex:{usage:"reactive"}}},"/x");
test("manual indefinite block persists, excludes ranking and prevents explicit delegation",async()=>{
 const ctx=withLoginIndicators(fakeCtx());await Bun.write(`${ctx.pacerHome}/strategy.yaml`,"planner: claude-code\nproviders:\n  claude-code: {usage: reactive}\n  agy: {usage: reactive}\n  codex: {usage: reactive}\n");
 expect((await executorCommand(["block","agy","--reason","maintenance"],ctx)).code).toBe(0);
 expect(readBlocked({...ctx,now:ctx.now+864000}).agy).toEqual({until:null,reason:"maintenance"});
 const st=await computeStatus(ctx,strategy,{profile:null});
 expect(st.executors.ranked.map(e=>e.id)).toEqual(["codex"]);
 expect(renderLine(st)).not.toContain("agy");
 await expect(delegate(ctx,{brief:{goal:"g",repo:ctx.home},executor:"agy"},()=>123,strategy)).rejects.toThrow("Blocked by you");
 const listed=await executorCommand(["list"],ctx);expect(listed.out).toContain("blocked by user until unblocked");
 const unblocked=await executorCommand(["unblock","agy"],ctx);
 expect(unblocked.out).toContain("agy: unblocked");
 expect(readBlocked(ctx).agy).toBeUndefined();
 const unblockedAgain=await executorCommand(["unblock","agy"],ctx);
 expect(unblockedAgain.out).toContain("agy: was not blocked by you");
});
test("timed manual block expires only when requested; invalid duration changes nothing",async()=>{
 const ctx=fakeCtx();blockExecutor(ctx,"agy","2h","pause");
 expect(readBlocked({...ctx,now:ctx.now+7199}).agy).toBeDefined();expect(readBlocked({...ctx,now:ctx.now+7200}).agy).toBeUndefined();
 expect(()=>blockExecutor(ctx,"codex","bad")).toThrow("duration");expect(readBlocked(ctx).codex).toBeUndefined();
});
test("executor list shows quota limit reached for exhausted executors",async()=>{
 const ctx=fakeCtx();await Bun.write(`${ctx.pacerHome}/strategy.yaml`,"planner: claude-code\nproviders:\n  claude-code: {usage: reactive}\n  agy: {usage: reactive}\n  codex: {usage: reactive}\n");
 const {markExhausted}=await import("../src/usage/reactive");
 markExhausted(ctx,"agy",ctx.now+3600,{manual:true});
 const listed=await executorCommand(["list"],ctx);
 expect(listed.out).toContain("agy: quota limit reached until");
 expect(listed.out).toContain("paid overflow is off for account agy (allow_paid: false)");
});
test("unblock adds quota exclusion info when executor is still excluded",async()=>{
 const ctx=fakeCtx();await Bun.write(`${ctx.pacerHome}/strategy.yaml`,"planner: claude-code\nproviders:\n  claude-code: {usage: reactive}\n  agy: {usage: reactive}\n  codex: {usage: reactive}\n");
 const {markExhausted}=await import("../src/usage/reactive");
 markExhausted(ctx,"agy",ctx.now+3600,{manual:true});
 blockExecutor(ctx,"agy","1h","test");
 const unblocked=await executorCommand(["unblock","agy"],ctx);
 expect(unblocked.out).toContain("agy: unblocked");
 expect(unblocked.out).toContain("agy: still excluded");
 expect(unblocked.out).toContain("quota limit reached until");
 expect(unblocked.out).toContain("(allow_paid: false)");
});
test("unblock without a manual block still names the quota limit and its latest reset",async()=>{
 const ctx=fakeCtx();await Bun.write(`${ctx.pacerHome}/strategy.yaml`,"planner: claude-code\nproviders:\n  claude-code: {usage: reactive}\n  agy: {usage: reactive}\n  codex: {usage: reactive}\n");
 const {markExhausted}=await import("../src/usage/reactive");
 const until=ctx.now+3*86400;markExhausted(ctx,"agy",until,{manual:true});
 const out=(await executorCommand(["unblock","agy"],ctx)).out;
 expect(out).toContain("agy: was not blocked by you");
 expect(out).toContain(`agy: still excluded · quota limit reached until ${new Date(until*1000).toISOString()}`);
});
test("an exhausted account that allows paid overflow is not described as quota-limited",async()=>{
 const ctx=fakeCtx();await Bun.write(`${ctx.pacerHome}/strategy.yaml`,"planner: claude-code\nproviders:\n  claude-code: {usage: reactive}\n  agy: {usage: reactive, allow_paid: true}\n  codex: {usage: reactive}\n");
 const {markExhausted}=await import("../src/usage/reactive");
 markExhausted(ctx,"agy",ctx.now+3600,{manual:true});blockExecutor(ctx,"agy","1h","test");
 const listed=(await executorCommand(["list"],ctx)).out;
 expect(listed).toContain("agy: blocked by user");
 const out=(await executorCommand(["unblock","agy"],ctx)).out;
 expect(out).not.toContain("allow_paid: false");
});
