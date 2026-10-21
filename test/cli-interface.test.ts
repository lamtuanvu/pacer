import { expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiTask } from "../src/api/read-model/tasks";
import { main } from "../src/cli";
import { io } from "../src/install/stdin";
import { delegate, parseDelegateBrief, summarizeTask } from "../src/tasks/api";
import { loadStrategy } from "../src/config/strategy";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { fakeCtx } from "./helpers";

function setup(){const ctx=fakeCtx();mkdirSync(ctx.pacerHome,{recursive:true});writeFileSync(join(ctx.pacerHome,"strategy.yaml"),"planner: claude-code\nproviders:\n  claude-code: {}\n  local: { via: opencode, model: local/q, usage: unmetered }\n");return ctx;}
const summaryKeys=["title","task_id","goal","state","kind","requested_executor","placement","queue","attempts","result","review","resolved"].sort();
test("CLI status and route pin JSON top-level keys",async()=>{
 const ctx=setup();
 expect(Object.keys(JSON.parse((await main(["status","--json"],ctx)).out)).sort()).toEqual(["generatedAt","strategy","planner","mode","disabled","calendarPace","accounts","providers","executors","paused","modeHold"].sort());
 expect(Object.keys(JSON.parse((await main(["route","debug","--json"],ctx)).out)).sort()).toEqual(["kind","ranked","excluded","uncertain"].sort());
});
test("brief-file and stdin preserve text and command flags override file fields",async()=>{
 const ctx=setup(),path=join(ctx.home,"brief.json"),goal="quotes ' \" and $()\nnext line";
 const brief={goal,repo:ctx.home,kind:"debug",executor:"local",scope:"s",acceptance:"true",constraints:"c",context:"ctx",timeout_min:2,worktree:"current",worktree_reason:"follow-up"};
 writeFileSync(path,JSON.stringify(brief));
 const fromFile=await main(["delegate","--brief-file",path,"--kind","docs","--timeout-min","3","--worktree","new","--json"],ctx);
 expect(fromFile.code).toBe(0);const t=JSON.parse(fromFile.out);
 expect(Object.keys(t).sort()).toEqual(["title","id","createdAt","brief","kind","requestedExecutor","timeoutS","state","attempts","placement","repo","rev","source"].sort());
 expect(t).toMatchObject({source:"cli",brief:{goal,repo:realpathSync(ctx.home),scope:"s"},kind:"docs",timeoutS:180,placement:{requested:"new",reason:"follow-up"}});
 const original=io.readBriefStdin;try{io.readBriefStdin=async()=>JSON.stringify(brief);const r=await main(["delegate","--brief-file","-","--goal","override","--title","  Queue fix  ","--json"],ctx);expect(r.code).toBe(0);expect(JSON.parse(r.out).brief.goal).toBe("override");expect(JSON.parse(r.out).title).toBe("Queue fix");}finally{io.readBriefStdin=original;}
});
test("brief validation is shared and executor CLI guard runs before reading stdin",async()=>{
 const ctx=setup();
 for(const raw of [{goal:42},{goal:"g",timeout_min:0},{goal:"g",worktree:"wrong"},{goal:"g",worktree_reason:"x".repeat(201)}])expect(()=>parseDelegateBrief(raw,ctx.home)).toThrow();
 expect(parseDelegateBrief({goal:"default"},ctx.home).brief.repo).toBe(ctx.home);
 const input=parseDelegateBrief({goal:"g",repo:"relative"},ctx.home);
 expect(()=>delegate(ctx,input,()=>1,loadStrategy(ctx))).toThrow("repo must be an absolute path");
 ctx.env.PACER_ROLE="executor";
 const guarded=await main(["delegate","--brief-file","-"],ctx);
 expect(guarded.code).toBe(2);expect(guarded.err).toContain("pacer executors cannot delegate onward");
});
test("task, list, wait, stop and review JSON contracts; review and dismiss persist",async()=>{
 const ctx=setup(),t=createTask(ctx,{brief:{goal:"g",repo:ctx.home},kind:null,requestedExecutor:null,timeoutS:60});
 updateTask(ctx,t.id,x=>{x.state="failed";});
 for(const cmd of ["tasks","wait","stop"]){const result=await main([cmd,t.id,"--json"],ctx);expect(result.code).toBe(0);expect(Object.keys(JSON.parse(result.out)).sort()).toEqual(summaryKeys);expect(JSON.parse(result.out)).toEqual(summarizeTask(readTask(ctx,t.id)!));}
 expect(Object.keys(JSON.parse((await main(["tasks","--json"],ctx)).out)[0]).sort()).toEqual(summaryKeys);
 for(const flag of ["--accept","--reject"]){const r=await main(["review",t.id,flag,"--kind","debug","--json"],ctx);expect(JSON.parse(r.out)).toEqual({task:apiTask(ctx,readTask(ctx,t.id)!)});expect(readTask(ctx,t.id)).toMatchObject({resolved:"reviewed",review:{accepted:flag==="--accept",kind:"debug"}});}
 expect((await main(["review",t.id,"--accept","--reject"],ctx)).code).toBe(2);
 const other=createTask(ctx,{brief:{goal:"h",repo:ctx.home},kind:null,requestedExecutor:null,timeoutS:60});
 expect((await main(["dismiss",t.id,other.id],ctx)).code).toBe(0);expect(readTask(ctx,t.id)?.dismissed).toBe(true);expect(readTask(ctx,other.id)?.dismissed).toBe(true);
});
test("wait times out with exit 2 and current status; validates timeout and missing task",async()=>{
 const ctx=setup(),t=createTask(ctx,{brief:{goal:"g",repo:ctx.home},kind:null,requestedExecutor:null,timeoutS:60});
 const r=await main(["wait",t.id,"--timeout","1","--json"],ctx);expect(r.code).toBe(2);expect(JSON.parse(r.out).state).toBe("queued");
 for(const n of ["0","3001","NaN","1.5"])expect((await main(["wait",t.id,"--timeout",n],ctx)).code).toBe(2);
 expect((await main(["wait","unknown"],ctx)).err).toContain("unknown task");
});
test("report-limit CLI records quota exhaustion for routing",async()=>{
 const ctx=setup(),{readMarks}=await import("../src/usage/reactive");
 expect((await main(["report-limit","local","--until","1234567890"],ctx)).code).toBe(0);expect(readMarks(ctx).local).toBe(1234567890);
 expect((await main(["report-limit","missing"],ctx)).code).toBe(2);expect((await main(["report-limit","local","--until","NaN"],ctx)).code).toBe(2);
});
test("brief-file rejects missing paths, malformed JSON and non-object JSON",async()=>{
 const ctx=setup(),path=join(ctx.home,"brief.json");
 expect((await main(["delegate","--brief-file"],ctx)).err).toContain("needs a path");
 for(const text of ["bad JSON","[]","null"]){writeFileSync(path,text);expect((await main(["delegate","--brief-file",path,"--json"],ctx)).code).toBe(2);}
});
test("CLI executor cwd detection refuses delegation without a role environment marker",async()=>{
 const ctx=setup(),cwd=process.cwd(),dir=join(ctx.home,"orca/workspaces/repo/pacer-t-20261011-140500-abcd-codex");mkdirSync(dir,{recursive:true});
 writeFileSync(join(ctx.pacerHome,"strategy.yaml"),"planner: claude-code\nproviders:\n  claude-code: {}\n  codex: { usage: reactive }\n");
 try{process.chdir(dir);const r=await main(["delegate","--brief-file","-"],ctx);expect(r.code).toBe(2);expect(r.err).toContain("pacer executors cannot delegate onward");}finally{process.chdir(cwd);}
});
test("wait blocks until the task settles and prints its final summary",async()=>{
 const ctx=setup(),task=createTask(ctx,{brief:{goal:"g",repo:ctx.home},kind:null,requestedExecutor:null,timeoutS:60});
 const timer=setTimeout(()=>updateTask(ctx,task.id,t=>{t.state="partial";}),20);
 try{const r=await main(["wait",task.id,"--timeout","2","--json"],ctx);expect(r.code).toBe(0);expect(JSON.parse(r.out).state).toBe("partial");}finally{clearTimeout(timer);}
});
