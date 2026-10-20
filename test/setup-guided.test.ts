import {expect,test} from "bun:test";
import {existsSync,readFileSync,statSync,mkdirSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {setupChecklist,setupText,type SetupFacts} from "../src/setup/checklist";
import {checkSetup,integrationIntact,withStatus} from "../src/setup/check";
import {legacySetup} from "../src/setup/v2";
import {setupAct} from "../src/dashboard/screens/setup";
import {callOp} from "../src/api/ops";
import {callV2Op,v2Hello} from "../src/api/v2-compat";
import {fakeCtx,tmpDir} from "./helpers";
import {sha256} from "../src/install/fsx";
import type {Status} from "../src/engine/status";
const facts:SetupFacts={version:"1.0",planner:"codex",signedIn:true,connected:true,service:{installed:true,running:true},link:true,agents:[{id:"codex",name:"Codex",installed:true},{id:"cursor",name:"Cursor",installed:false}],executors:{ranked:[{id:"cursor"}],excluded:[]},verdict:"OK",reviewed:true};
const item=(f:SetupFacts,id:string)=>setupChecklist(f,1).items.find(i=>i.id===id)!;
test("guided item order, optional rows, complete and ready",()=>{
 const s=setupChecklist(facts,1);
 expect(s.items.map(i=>i.id)).toEqual(["binary","planner","service","connect","link","executor","usage","first","agent:cursor"]);
 expect(s).toMatchObject({complete:true,ready:true});expect(setupText(s)).toBe("Setup ✓");
 for(const patch of [{version:null},{planner:null},{signedIn:false},{connected:false},{service:{installed:false,running:false}},{service:{installed:true,running:false}},{link:false}]){
  expect(setupChecklist({...facts,...patch},1)).toMatchObject({complete:false,ready:false});
 }
 for(const patch of [{verdict:"UNKNOWN"},{reviewed:false},{executors:{ranked:[],excluded:[]}}])expect(setupChecklist({...facts,...patch},1).complete).toBe(true);
 expect(setupChecklist({...facts,reviewed:false},1).ready).toBe(false);
 expect(setupChecklist({...facts,reviewed:false,skipped:true},1).ready).toBe(true);
 expect(item({...facts,version:null},"binary").status).toBe("pending");
 expect(item({...facts,errors:{service:"unreachable"}},"service")).toMatchObject({status:"failed",detail:"unreachable"});
 expect(setupChecklist(facts,1).items.some(i=>i.id==="live")).toBe(false);
 expect(item(facts,"agent:cursor")).toMatchObject({status:"pending",action:"agent.connect",agent:"cursor"});
 expect(item({...facts,agents:[{id:"cursor",name:"Cursor",installed:true}]},"agent:cursor").status).toBe("done");
});
test("signed-out planner uses provider login; unknown usage and exclusions explain next steps",()=>{
 expect(item({...facts,signedIn:false,loginCommand:"codex login"},"planner")).toMatchObject({status:"pending",detail:"codex · signed out",command:"codex login"});
 expect(item({...facts,verdict:"UNKNOWN"},"usage")).toMatchObject({status:"pending",detail:"Start a session in codex once"});
 expect(item(facts,"usage").status).toBe("done");
 expect(item({...facts,executors:{ranked:[],excluded:[]}},"executor")).toMatchObject({status:"pending",detail:"no executor configured",action:"nav:add-executor"});
 expect(item({...facts,executors:{ranked:[],excluded:[{id:"cursor",reason:"signed out"}]}},"executor").detail).toBe("cursor: signed out");
});
test("snapshot status enriches setup without probes",()=>{
 const st:Status={generatedAt:1,strategy:"default",planner:"codex",mode:"normal",disabled:false,calendarPace:false,providers:[],executors:{ranked:[],excluded:[{id:"cursor",reason:"not installed"}]}};
 const s=withStatus(setupChecklist(facts,1),st);
 expect(s.ready).toBe(false);expect(s.items.find(i=>i.id==="usage")?.status).toBe("pending");expect(s.items.find(i=>i.id==="executor")?.detail).toContain("not installed");
});
test("TUI setup rows use advertised operations, hide try until an executor is ranked",()=>{
 const s=setupChecklist({...facts,connected:false,service:{installed:false,running:false},reviewed:false,executors:{ranked:[],excluded:[]}},1);
 const ops=["service.install","agent.connect","agent.preview","onboarding.skip"];
 const act=(checklist:typeof s,id:string,offered=ops)=>setupAct(checklist,checklist.items.find(i=>i.id===id)!,op=>offered.includes(op));
 expect(act(s,"service")).toMatchObject({effect:{type:"action",action:{op:"service.install",params:{consent:true}}},confirm:{title:expect.stringContaining("background")}});
 expect(act(s,"connect")).toMatchObject({effect:{type:"flow",name:"connect-agent",params:{agent:"codex"}}});
 // Without a preview there is no consent dialog: the step shows its command instead.
 expect(act(s,"connect",["agent.connect"])?.effect.type).not.toBe("flow");
 expect(act(s,"executor")).toMatchObject({effect:{type:"handoff",argv:["runner","add"]}});
 expect(act(s,"first",[...ops,"onboarding.try"])).toBeUndefined();
 const ranked=setupChecklist({...facts,reviewed:false,executors:{ranked:[{id:"cursor"}],excluded:[]}},1);
 expect(act(ranked,"first",[...ops,"onboarding.try"])).toMatchObject({effect:{type:"action",action:{op:"onboarding.try",params:{}}}});
 expect(act(setupChecklist(facts,1),"service")).toBeUndefined();
});
test("v2 maps chosen signed-out planner to Strategy and removes new rows and fields",()=>{
 const s=setupChecklist({...facts,signedIn:false,connected:false},1),before=JSON.stringify(s),v2=legacySetup(s);
 expect(JSON.stringify(s)).toBe(before);expect(v2).not.toHaveProperty("ready");expect(v2.complete).toBe(true);
 expect(v2.items.map(i=>i.id)).toEqual(["binary","strategy","service","link","live","agent:claude-code","agent:codex","agent:cursor","agent:opencode"]);
 expect(v2.items.every(i=>!i.action&&!i.agent&&!i.detail)).toBe(true);
});
test("skip is persistent and private; new ops stay v3-only and install requires true consent",async()=>{
 const ctx=fakeCtx({home:tmpDir(),pacerHome:tmpDir(),which:()=>null});
 for(const params of [{},{consent:false}])await expect(callOp(ctx,"service.install",params)).rejects.toMatchObject({code:"invalid_input"});
 expect(await callOp(ctx,"onboarding.skip",{})).toEqual({skipped:true});
 expect(await callOp(ctx,"onboarding.skip",{})).toEqual({skipped:true});
 const marker=join(ctx.pacerHome,"onboarding/skipped");expect(existsSync(marker)).toBe(true);expect(statSync(marker).mode&0o777).toBe(0o600);
 expect(statSync(join(ctx.pacerHome,"onboarding")).mode&0o777).toBe(0o700);
 expect(v2Hello().ops).not.toContain("onboarding.skip");
 await expect(callV2Op(ctx,"onboarding.skip",{})).rejects.toMatchObject({code:"unknown_op"});
 const s=await checkSetup(ctx,{snapshotProbe:false});expect(s.items.find(i=>i.id==="first")?.status).toBe("done");
});
test("integration checks accept managed edits but reject missing or altered pieces",()=>{
 const path=join(tmpDir(),"AGENTS.md"),text="<!-- >>> pacer >>> -->\npolicy\n<!-- <<< pacer <<< -->\n";
 writeFileSync(path,text);const file={path,action:"created" as const,afterHash:sha256(text),undo:[]};expect(integrationIntact(file)).toBe(true);
 writeFileSync(path,text+"user additions\n");expect(integrationIntact({...file,undo:[{kind:"block",style:"md"}]})).toBe(true);
 writeFileSync(path,"changed");expect(integrationIntact(file)).toBe(false);
 expect(integrationIntact({...file,path:join(tmpDir(),"missing")})).toBe(false);
});

test("service installation uses consent, reports status and rejects concurrent installers",async()=>{
 const {serviceInstall}=await import("../src/core/setup");
 const ctx=fakeCtx(),calls:string[]=[];let release!:()=>void;
 const wait=new Promise<void>(resolve=>{release=resolve;});
 const backend={install:async()=>{calls.push("install");await wait;return [];},status:async()=>{calls.push("status");return {installed:true,running:true} as any;}};
 await expect(serviceInstall(ctx,false,backend)).rejects.toMatchObject({code:"not_allowed"});expect(calls).toEqual([]);
 const installing=serviceInstall(ctx,true,backend);
 await expect(serviceInstall(ctx,true,backend)).rejects.toMatchObject({code:"conflict"});
 release();expect(await installing).toEqual({installed:true,running:true});expect(calls).toEqual(["install","status"]);
});

test("planner connection uses manifest integrity, login and the selected account",async()=>{
 const {agentConnect,agentPreview}=await import("../src/core/setup");
 const {loadStrategy}=await import("../src/config/strategy");
 const home=tmpDir(),ctx=fakeCtx({home,which:()=>null,env:{PACER_BIN:"/tmp/pacer-fixture"}});
 mkdirSync(ctx.pacerHome,{recursive:true});
 writeFileSync(join(ctx.pacerHome,"strategy.yaml"),"planner: codex\nproviders:\n  codex: {}\n");
 expect((await checkSetup(ctx,{snapshotProbe:false,deferStatus:true})).items.find(i=>i.id==="planner")?.status).toBe("pending");
 mkdirSync(join(home,".codex"),{recursive:true});writeFileSync(join(home,".codex/auth.json"),"{}");
 await agentConnect(ctx,"codex",{consent:true});
 let setup=await checkSetup(ctx,{snapshotProbe:false,deferStatus:true});
 expect(setup.items.find(i=>i.id==="planner")?.status).toBe("done");expect(setup.items.find(i=>i.id==="connect")?.status).toBe("done");
 writeFileSync(join(home,".codex/AGENTS.md"),"removed integration");
 expect((await checkSetup(ctx,{snapshotProbe:false,deferStatus:true})).items.find(i=>i.id==="connect")?.status).toBe("pending");
 // A dedicated planner account must not silently connect the default home.
 const folder=join(home,"work-codex");
 writeFileSync(join(ctx.pacerHome,"strategy.yaml"),`planner: codex#work\naccounts:\n  work:\n    kind: codex\n    source: home\n    home: ${folder}\nrunners:\n  codex#work: {}\n`);
 expect(loadStrategy(ctx).planner.account).toBe("work");
 expect(agentPreview(ctx,"codex").files).toContain(join(folder,"AGENTS.md"));
 await agentConnect(ctx,"codex",{consent:true});
 expect(existsSync(join(folder,"AGENTS.md"))).toBe(true);
 expect((await checkSetup(ctx,{snapshotProbe:false,deferStatus:true})).items.find(i=>i.id==="connect")?.status).toBe("done");
});

test("reviewing a task completes first; polled setup reuses previously gathered status",async()=>{
 const {writeJsonAtomic}=await import("../src/fsutil");
 const ctx=fakeCtx({which:()=>null}),commands:string[][]=[];
 ctx.run=async argv=>{commands.push(argv);return {code:127,stdout:"",stderr:"not installed"};};
 const st:Status={generatedAt:ctx.now,strategy:"default",planner:"codex",mode:"normal",disabled:false,calendarPace:false,providers:[{id:"codex",installed:true,usage:"quota",windows:[],binding:null,verdict:"OK",stale:false}],executors:{ranked:[{id:"cursor",verdict:"OK",reason:"ready",score:1}],excluded:[]}};
 withStatus(setupChecklist(facts,ctx.now),st,ctx);
 mkdirSync(ctx.pacerHome,{recursive:true});writeFileSync(join(ctx.pacerHome,"strategy.yaml"),"planner: codex\nproviders:\n  codex: {}\n");
 const id="t-20261010-190000-abcd";
 writeJsonAtomic(join(ctx.pacerHome,`tasks/${id}.json`),{id,rev:1,createdAt:ctx.now,brief:{goal:"test",repo:ctx.home},kind:null,requestedExecutor:null,timeoutS:60,state:"done",attempts:[],review:{accepted:false,kind:null,note:null,at:ctx.now}});
 const s=await checkSetup(ctx,{snapshotProbe:false});
 expect(s.items.find(i=>i.id==="first")?.status).toBe("done");expect(s.items.find(i=>i.id==="executor")?.status).toBe("done");expect(s.items.find(i=>i.id==="usage")?.status).toBe("done");
 expect(commands.every(argv=>["launchctl","systemctl"].includes(argv[0]!))).toBe(true);
});

test("dashboard client uses v3 operations without changing shared v2 clients",async()=>{
 const {dashboardClient}=await import("../src/dashboard/client");
 const ctx=fakeCtx({env:{PACER_PORT:"49999"}}),paths:string[]=[];
 mkdirSync(ctx.pacerHome,{recursive:true});writeFileSync(join(ctx.pacerHome,"token"),"test-token");
 const original=globalThis.fetch;
 globalThis.fetch=(async(input:any,init:any)=>{
  const url=String(input);paths.push(new URL(url).pathname);
  if(url.endsWith("/health"))return new Response("",{headers:{"x-pacer":"1"}});
  if(url.endsWith("/hello"))return Response.json({protocol:"3.0.0",ops:["onboarding.skip"]});
  expect(JSON.parse(init.body)).toEqual({});return Response.json({result:{skipped:true}});
 }) as typeof fetch;
 let client:Awaited<ReturnType<typeof dashboardClient>>|undefined;
 try{
  client=await dashboardClient(ctx);expect((await client.hello()).ops).toContain("onboarding.skip");
  expect(await client.call<{skipped:boolean}>("onboarding.skip",{})).toEqual({skipped:true});
  expect(paths).toEqual(["/health","/v3/hello","/v3/ops/onboarding.skip"]);
 }finally{client?.close();globalThis.fetch=original;}
});

test("TUI consent dialog leaves room for integration and status line details",async()=>{
 const {renderDashboard}=await import("../src/dashboard/render");
 const {emptySnapshot}=await import("../src/link/envelope");
 const body=["settings.json: SessionStart and PreToolUse hooks; the existing status line will be left alone. Pipe input JSON to pacer statusline to include budgets.","No MCP servers will be added."];
 const checklist=setupChecklist({...facts,reviewed:false},1);
 const act={label:"Connect",effect:{type:"local" as const,label:"",run(){}}};
 const text=renderDashboard({...emptySnapshot(),setup:{...checklist,open:1}},80,24,1,{selected:0,noColor:true,state:{overlay:{kind:"confirm",title:"Connect Claude Code?",body,yes:"Connect",act}}});
 expect(text).toContain("Connect Claude Code?");expect(text).toContain("status line will be left alone.");expect(text).toContain("include budgets.");expect(text).toContain("No MCP servers will be added.");
 expect(text).toContain("y Connect");expect(text).toContain("n Cancel");
});


test("setup steps and their primary action fit a standard terminal",async()=>{
 const {renderDashboard}=await import("../src/dashboard/render");
 const {emptySnapshot}=await import("../src/link/envelope");
 const setup=setupChecklist({...facts,connected:false,service:{installed:false,running:false},reviewed:false,executors:{ranked:[],excluded:[]}},1);
 const text=renderDashboard({...emptySnapshot(),setup:{...setup,open:4}},80,24,1,{noColor:true,ops:["service.install","agent.connect","agent.preview","onboarding.skip"]});
 for(const step of ["Background service","Connect planner","Executor","First delegation"])expect(text).toContain(step);
 expect(text.split("\n").at(-1)).toContain("⏎ Install service");
 expect(text).not.toContain("Try a delegation");
});
