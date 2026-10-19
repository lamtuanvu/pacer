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
 expect(()=>delegate(ctx,{brief:{goal:"g",repo:ctx.home},executor:"agy"},()=>123,strategy)).toThrow("Blocked by you");
 const listed=await executorCommand(["list"],ctx);expect(listed.out).toContain("blocked by user until unblocked");
 await executorCommand(["unblock","agy"],ctx);expect(readBlocked(ctx).agy).toBeUndefined();
});
test("timed manual block expires only when requested; invalid duration changes nothing",async()=>{
 const ctx=fakeCtx();blockExecutor(ctx,"agy","2h","pause");
 expect(readBlocked({...ctx,now:ctx.now+7199}).agy).toBeDefined();expect(readBlocked({...ctx,now:ctx.now+7200}).agy).toBeUndefined();
 expect(()=>blockExecutor(ctx,"codex","bad")).toThrow("duration");expect(readBlocked(ctx).codex).toBeUndefined();
});
