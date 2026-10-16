import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { callOp } from "../src/api/ops";
import { createTask } from "../src/tasks/store";
import { emptySnapshot, LIMITS, clip } from "../src/link/envelope";
import { initialState, reduceStore } from "../app/src/data/store";
import { mergeTask, tasksModel } from "../app/src/model/tasks";
import { executorLabel } from "../src/view-model/words";
import { executorStatus, routingStatus } from "../app/src/model/executors";
import { homeModel } from "../app/src/model/home";
import { setupModel } from "../app/src/model/setup";
import { endpointResult, modelsFound } from "../app/src/model/wizard";
import { accountsModel } from "../app/src/model/accounts";

// 1–3: all server fixtures are isolated from the user's account and agent homes.
test("setup.init leaves editable current accounts and runners", async () => {
 const ctx = fakeCtx();
 await callOp(ctx, "setup.init", {planner:"claude-code"});
 await expect(callOp(ctx,"account.add",{kind:"codex",name:"work"})).resolves.toMatchObject({account:{name:"work"}});
 await expect(callOp(ctx,"runner.add",{agent:"codex",account:"work"})).resolves.toEqual({id:"codex#work"});
});
test("task summaries include the clipped brief goal", async () => {
 const ctx=fakeCtx(), goal="Goal ".repeat(100);
 const t=createTask(ctx,{brief:{goal,repo:ctx.home},kind:null,requestedExecutor:null,timeoutS:60});
 expect(await callOp(ctx,"task.get",{id:t.id})).toMatchObject({goal:clip(goal,LIMITS.goal)});
 expect(await callOp(ctx,"task.list",{})).toEqual(expect.arrayContaining([expect.objectContaining({goal:clip(goal,LIMITS.goal)})]));
});
test("checklist distinguishes installed CLI from connected integration", async () => {
 const ctx=fakeCtx({which:bin=>bin==="codex"?"/fixture/codex":null});
 const check=await callOp(ctx,"setup.check",{}) as any;
 expect(check.items.find((i:any)=>i.id==="agent:codex")).toMatchObject({installed:true,status:"pending"});
 expect(check.items.find((i:any)=>i.id==="agent:claude-code")).toMatchObject({installed:false,status:"pending"});
});
test("task completion updates the store and both task view models", () => {
 const live={id:"t1",goal:"Write tests",state:"queued",executor:"codex",backend:null,worktree:null,updatedAt:1};
 const start=reduceStore(initialState(),{type:"snapshot",snapshot:{...emptySnapshot(),seq:1,tasks:[live]}});
 const next=reduceStore(start,{type:"event",event:{seq:2,at:2,type:"task",data:{...live,state:"done",updatedAt:2}}});
 expect(next.snapshot?.tasks[0]?.state).toBe("done");
 const task={task_id:"t1",goal:"Write tests",state:"done",kind:null,requested_executor:null,attempts:[],result:null,review:null,resolved:null};
 expect(mergeTask(task,live).state).toBe("done");
 expect(mergeTask({...task,state:"running"},live).state).toBe("running");
 expect(tasksModel([task],[],"review")[0]?.goal).toBe("Write tests");
 expect(start.snapshot?.tasks[0]?.state).toBe("queued");
});
test("executor labels identify agents, endpoint accounts and named budgets", () => {
 for(const [id,label] of Object.entries({"claude-code":"Claude Code",codex:"Codex",cursor:"Cursor",agy:"Antigravity","codex#work":"Codex · work","opencode#fakecloud":"fakecloud"})) expect(executorLabel(id,[])).toBe(label);
 expect(executorLabel("codex#personal",[{name:"personal",kind:"codex",source:"default"}])).toBe("Codex");
});
test("routing verdicts are words and unknown is neutral", () => {
 for(const [verdict,label] of [["OK","Ready"],["UNKNOWN","Usage unknown"],["AHEAD","Ahead of pace"],["EXHAUSTED","Out of quota"]]) expect(routingStatus({verdict,reason:"ok, used 0%"}).label).toBe(label);
 const snapshot={...emptySnapshot(),budget:{generatedAt:1,planner:"codex",strategy:"default",mode:"normal",ranked:[],providers:[{id:"codex",verdict:"UNKNOWN",usedPct:null,pacePct:null,resetsAt:null,window:null,stale:false}]}};
 expect(homeModel(snapshot,[]).planner?.tone).toBe("neutral");
});
test("native executor states use installation, routing and runner overrides", () => {
 const runner={id:"codex",state:"ok" as const,until:null,reason:null};
 expect(executorStatus(runner).label).toBe("Ready");
 expect(executorStatus(runner,undefined,false).label).toBe("Not installed");
 expect(executorStatus({...runner,state:"blocked",until:100}).label).toContain("Blocked until");
 expect(executorStatus({...runner,state:"exhausted"}).label).toBe("Out of quota");
 expect(executorStatus({...runner,state:"broken",reason:"CLI failed"}).label).toBe("Not working · CLI failed");
 expect(executorStatus({...runner,id:"opencode#local"},{name:"local",kind:"endpoint",state:"not_tested",connection:{models:[]}}).label).toBe("Not tested");
});
test("executor controls live in a More disclosure with small ghost ordering", () => {
 const source=readFileSync(join(import.meta.dir,"../app/src/screens/Executors.tsx"),"utf8");
 expect(source).toContain('<summary>More</summary>');
 expect(source.indexOf('<summary>More</summary>')).toBeLessThan(source.indexOf('Block for <select'));
 expect(source).toContain('variant="ghost" size="sm"');
});
test("wizard keeps endpoint failure details and pluralizes model discovery", () => {
 expect(endpointResult({state:"not_working",detail:"test task failed: refused"})).toEqual({state:"not_working",detail:"test task failed: refused"});
 expect(endpointResult({state:{state:"not_working",detail:"redacted reason"}}).detail).toBe("redacted reason");
 expect(modelsFound(1)).toBe("1 model found. Choose models below.");
 expect(modelsFound(2)).toBe("2 models found. Choose models below.");
});
test("wizard and delegate controls have wrapping labels", () => {
 for(const file of ["AddExecutor","Delegate"]){
 const source=readFileSync(join(import.meta.dir,`../app/src/screens/${file}.tsx`),"utf8");
 for(const match of source.matchAll(/<(input|textarea|select)\b/g)) {
 const prefix=source.slice(0,match.index);
 expect(prefix.lastIndexOf("<label")).toBeGreaterThan(prefix.lastIndexOf("</label>"));
 }
 }
});
test("setup hides finished commands and gives clear missing strategy guidance", () => {
 const model=setupModel({checkedAt:0,complete:false,items:[{id:"link",title:"Link",required:true,status:"done",command:"pacer init"},{id:"strategy",title:"Strategy",required:true,status:"failed",detail:"no strategy found at /private/fixture"},{id:"link",title:"Link",required:true,status:"pending"}]});
 expect(model.items[0]?.command).toBeUndefined();
 expect(model.items[1]?.detail).toBe("No strategy yet. Choose a planner to create one.");
 expect(model.items[2]?.guidance).toBe("Start pacer: pacer service install");
 const source=readFileSync(join(import.meta.dir,"../app/src/screens/Setup.tsx"),"utf8");
 expect(source.match(/variant="primary"/g)).toHaveLength(1);
 expect(source).toContain('variant="ghost" onClick={query.reload}>Check again');
 expect(source).toContain("i.action==='service'&&i.status!=='done'");
});
test("accounts capitalize guidance and simplify default-folder sign-in commands", () => {
 const rows=accountsModel([{name:"personal",kind:"claude",folder:"/fixture/.claude",signin_command:"CLAUDE_CONFIG_DIR='/fixture/.claude' claude\n# Then run /login to sign in."},{name:"work",kind:"codex",folder:"/fixture/.codex-work",signin_command:"CODEX_HOME='/fixture/.codex-work' codex login"}], [{account:"personal",capturedAt:1,stale:true,hint:"run codex login"}]);
 expect(rows[0]?.signin).toBe("claude\n# Then run /login to sign in.");
 expect(rows[1]?.signin).toContain("CODEX_HOME");
 expect(accountsModel([{name:"default",kind:"codex",folder:"/fixture/.codex",signin_command:"CODEX_HOME=fixture codex login"}],[])[0]?.signin).toBe("codex login");
 expect(rows[0]?.freshness).toStartWith("Stale since");
 expect(rows[0]?.hint).toBe("Run codex login");
 const source=readFileSync(join(import.meta.dir,"../app/src/screens/Accounts.tsx"),"utf8");
 expect(source).toContain('<div className="row"><Button size="sm" variant="secondary"');
});
