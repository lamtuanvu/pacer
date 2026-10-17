import { expect, test } from "bun:test";
import { resolvePlacement, type TaskRecord } from "../src/tasks/types";
import { delegate, validateInput } from "../src/tasks/api";
import { validateStrategy } from "../src/config/strategy";
import { parseEnvelope } from "../src/link/envelope";
import { taskData } from "../src/link/pump";
import { summarizeTask } from "../src/mcp/server";
import { placementLine } from "../orca-plugin/src/panel/overview";
import { fakeCtx, tmpDir } from "./helpers";
const s=validateStrategy({planner:"claude-code",providers:{"claude-code":{},codex:{}}},"/x");
const brief={goal:"fix it",repo:"/repo"};
for(const mode of ["current","new"] as const)test(`explicit ${mode} overrides all automatic hints`,()=>{
 for(const busy of [true,false])for(const reason of [undefined,"small follow-up"]){
 expect(resolvePlacement({brief:{...brief,context:"uncommitted"},kind:"research",placement:{requested:mode,reason}},"child-of-current",busy)).toEqual({mode,why:`agent: ${reason??"no reason given"}`});
 }
});
for(const request of [undefined,"auto"] as const)test(`automatic ${request} rules`,()=>{
 const base={brief,kind:null,placement:request?{requested:request}:undefined};
 expect(resolvePlacement({...base,kind:"research"},"new-child",false)).toEqual({mode:"current",why:"read-only kind"});
 for(const field of ["goal","context","scope"] as const)for(const hint of ["UNCOMMITTED","in-progress","in progress","working-tree","working tree","unstaged"]){
 expect(resolvePlacement({...base,brief:{...brief,[field]:`build on ${hint} changes`}},"new-child",false,true)).toEqual({mode:"current",why:"builds on uncommitted work"});
 expect(resolvePlacement({...base,brief:{...brief,[field]:`build on ${hint} changes`}},"new-child",false,false)).toEqual({mode:"new",why:"strategy default"});
 }
 expect(resolvePlacement({...base,kind:"research"},"current",true)).toEqual({mode:"new",why:"another task is writing there"});
 expect(resolvePlacement({...base,brief:{...brief,context:"uncommitted"}},"current",true)).toEqual({mode:"new",why:"another task is writing there"});
 for(const strategy of ["current","child-of-current","new-child"] as const)expect(resolvePlacement(base,strategy,false)).toEqual({mode:strategy==="current"?"current":"new",why:"strategy default"});
});
test("delegate validates and stores placement before spawning",()=>{
 const ctx=fakeCtx(), b={...brief,repo:tmpDir()};
 for(const value of ["child-of-current","",null,123])expect(validateInput(s,{brief:b,worktree:value as any})).toContain("worktree must be one of current, new, auto");
 for(const reason of ["x".repeat(201),123,null])expect(validateInput(s,{brief:b,worktree_reason:reason as any})).toContain("worktree_reason must be a string of at most 200 characters");
 for(const worktree of ["current","new","auto"] as const){const t=delegate(ctx,{brief:b,worktree,worktree_reason:"x".repeat(200)},()=>undefined,s);expect(t.placement).toEqual({requested:worktree,reason:"x".repeat(200)});}
 expect(delegate(ctx,{brief:b},()=>undefined,s).placement).toEqual({requested:"auto"});
});
test("resolved placement propagates through status, link and escaped panel text",()=>{
 const t={rev:1,id:"t",state:"running",createdAt:1,kind:null,requestedExecutor:null,timeoutS:60,brief,attempts:[],worktree:"/new/path",placement:{requested:"new",mode:"new",why:"agent: <risky>"}} as TaskRecord;
 const d=taskData(t);expect(summarizeTask(t).placement).toMatchObject({mode:"new",why:"agent: <risky>"});expect(d.worktree).toBe("/new/path");
 const parsed=parseEnvelope({v:1,type:"task",data:d});expect(parsed).toMatchObject({data:{placement:{mode:"new",why:"agent: <risky>"}}});
 expect(placementLine(d)).toContain('class="muted"');expect(placementLine(d)).toContain("new worktree /new/path (agent: &lt;risky&gt;)");
 for(const placement of [{mode:"invalid",why:"x"},{mode:"new",why:42},null])expect(parseEnvelope({v:1,type:"task",data:{...d,placement}})).not.toHaveProperty("data.placement");
 expect(parseEnvelope({v:1,type:"task",data:{...d,placement:{mode:"current",why:"x".repeat(500)}}})).toMatchObject({data:{placement:{mode:"current",why:"x".repeat(240)}}});
});
