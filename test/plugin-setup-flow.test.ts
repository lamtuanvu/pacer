import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveFocusedWorktree } from "../orca-plugin/src/worktree";
import { createBootstrap, resolveOrcaCli } from "../orca-plugin/src/bootstrap";
import { readLiveHeartbeat, removeLiveHeartbeat, writeLiveHeartbeat } from "../src/plugin/live";
import { tmpDir } from "./helpers";
function host(context:any) { return {call:async()=>context} as any; }
for(const [name,context,rows,id] of [
 ["id present",{branch:"main",worktreeId:"direct"},[],"direct"],
 ["exact match",{branch:"main",displayName:"Main"},[{id:"wrong",branch:"main",displayName:"Other"},{id:"right",branch:"main",displayName:"Main"}],"right"],
 ["recent duplicate",{branch:"main",displayName:"Main"},[{id:"old",branch:"main",displayName:"Main",lastActivityAt:1},{id:"new",branch:"main",displayName:"Main",lastActivityAt:2}],"new"],
 ["no match",{branch:"other",displayName:"Main"},[],null], ["no context",null,[],null], ["no branch",{worktreeId:"id"},[],null],
] as const)test(`focus resolution: ${name}`,async()=>{
 let calls=0;const result=await resolveFocusedWorktree(host(context),async(_bin,args)=>{calls++;expect(args).toEqual(["worktree","list","--json"]);return JSON.stringify({result:{worktrees:rows}});},"orca");expect(result).toEqual(id?{id}:null);if(name==="id present"||name==="no context"||name==="no branch")expect(calls).toBe(0);
});
function harness() {
 const home=tmpDir(),env={HOME:home,PACER_BIN:"/fixture/pacer",PATH:"/missing",ORCA_CLI_COMMAND:"/fixture/orca"};let at=100,context:any={branch:"main",displayName:"Main"},pid=111,installed=false,fail=false;
 const storage=new Map<string,any>(),notifications:string[]=[],calls:string[][]=[];
 const ctx:any={log(){},host:{call:async(method:string,params:any)=>{
  if(method==="workspace.readContext")return context;
  if(method==="settings.get")return {settings:{}};
  if(method==="storage.get")return {value:structuredClone(storage.get(params.key))};
  if(method==="storage.set"){storage.set(params.key,structuredClone(params.value));return {ok:true};}
  if(method==="notifications.show"){notifications.push(params.title);return {delivered:true};}
 }}};
 const deps={home,env,version:"0.1.22",mode:"bootstrap" as const,now:()=>at,exec:async(_bin:string,args:string[])=>{
  calls.push(args);if(args[0]==="--version")return "pacer 0.1.22";
  if(args[0]==="worktree")return JSON.stringify({ok:true,result:{worktrees:[{id:"focused",branch:"main",displayName:"Main"}]}});
  if(args[0]==="status")return JSON.stringify({result:{app:{pid}}});
  if(args[0]==="service")return JSON.stringify({installed});
  if(args[0]==="terminal"){
   expect(storage.get("bootstrap").dashboardSessions).toContain(`pid:${pid}`);expect(args[args.indexOf("--worktree")+1]).toBe("id:focused");
   return JSON.stringify(fail?{ok:false,error:{message:"failed"}}:{ok:true,result:{terminal:{handle:"term"}}});
  }
  throw new Error(args.join(" "));
 }};
 return {home,ctx,deps,calls,storage,notifications,setContext:(v:any)=>context=v,time:(v:number)=>at=v,pid:(v:number)=>pid=v,installed:(v:boolean)=>installed=v,fail:()=>fail=true};
}
test("fresh bootstrap opens init once per pid, persists reservation through restart",async()=>{
 const h=harness(),b=createBootstrap(h.deps);await b.activate(h.ctx);await b.run(h.ctx,()=>{});
 expect(h.calls.filter(a=>a[0]==="terminal")[0]?.join(" ")).toContain("/fixture/pacer init");
 expect(h.calls.some(a=>a[0]==="init"||a[1]==="install"||a[1]==="restart")).toBe(false);
 const next=createBootstrap(h.deps);await next.activate(h.ctx);h.time(700);await next.run(h.ctx,()=>{});expect(h.calls.filter(a=>a[0]==="terminal")).toHaveLength(1);
 h.pid(222);h.time(1300);await next.run(h.ctx,()=>{});expect(h.calls.filter(a=>a[0]==="terminal")).toHaveLength(2);
});
test("set-up bootstrap opens dashboard; focus missing retries without reserving",async()=>{
 const h=harness();h.installed(true);mkdirSync(join(h.home,".pacer"));writeFileSync(join(h.home,".pacer/strategy.yaml"),"fixture");h.setContext(null);
 const b=createBootstrap(h.deps);await b.run(h.ctx,()=>{});expect(b.state.dashboardSessions).toBeUndefined();expect(b.state.nextAt).toBe(130);
 h.setContext({branch:"main",displayName:"Main"});h.time(129);await b.run(h.ctx,()=>{});expect(h.calls.some(a=>a[0]==="terminal")).toBe(false);
 h.time(130);await b.run(h.ctx,()=>{});expect(h.calls.find(a=>a[0]==="terminal")?.join(" ")).toContain("/fixture/pacer dashboard");
});
test("live heartbeat makes marketplace dormant with one notice per version",async()=>{
 const h=harness();writeLiveHeartbeat(join(h.home,".pacer"),{version:"0.1.22",pid:42,at:100});
 const b=createBootstrap(h.deps);await b.run(h.ctx,()=>{});expect(h.calls).toHaveLength(0);expect(h.notifications).toEqual(["pacer now runs from its live panel. You can uninstall the marketplace copy in Orca Settings > Plugins."]);
 const next=createBootstrap(h.deps);await next.activate(h.ctx);h.time(130);await next.run(h.ctx,()=>{});expect(h.notifications).toHaveLength(1);
 const upgrade=createBootstrap({...h.deps,version:"0.1.23"});await upgrade.activate(h.ctx);h.time(160);await upgrade.run(h.ctx,()=>{});expect(h.notifications).toHaveLength(2);
});
test("terminal failure is reserved before call, with one manual init notice",async()=>{
 const h=harness();h.fail();const b=createBootstrap(h.deps);await b.run(h.ctx,()=>{});expect(h.notifications).toHaveLength(1);expect(h.notifications[0]).toContain("/fixture/pacer init");
 const next=createBootstrap(h.deps);await next.activate(h.ctx);h.time(160);await next.run(h.ctx,()=>{});expect(h.calls.filter(a=>a[0]==="terminal")).toHaveLength(1);expect(h.notifications).toHaveLength(1);
});
test("heartbeat freshness and owned removal",()=>{
 const dir=tmpDir();writeLiveHeartbeat(dir,{version:"v",pid:1,at:100});expect(readLiveHeartbeat(dir,189)?.pid).toBe(1);expect(readLiveHeartbeat(dir,190)).toBeNull();removeLiveHeartbeat(dir,2);expect(existsSync(join(dir,"plugin-live.json"))).toBe(true);removeLiveHeartbeat(dir,1);expect(readLiveHeartbeat(dir,100)).toBeNull();
});
test("CLI resolution prefers env, PATH, then installed app",()=>{expect(resolveOrcaCli({ORCA_CLI_COMMAND:"custom"})).toBe("custom");expect(resolveOrcaCli({PATH:"/no-cli"})).toBe(existsSync("/Applications/Orca.app/Contents/Resources/bin/orca")?"/Applications/Orca.app/Contents/Resources/bin/orca":"orca");});
test("plugin terminal creates never use active",()=>{const text=readFileSync(new URL("../orca-plugin/src/bootstrap.ts",import.meta.url),"utf8");expect(text).not.toContain('"--worktree", "active"');});
test("live consent shell creation resolves focus ID without installing anything",async()=>{
 const h=harness();h.installed(true);mkdirSync(join(h.home,".pacer"));writeFileSync(join(h.home,".pacer/strategy.yaml"),"fixture");
 mkdirSync(join(h.home,"bin"));writeFileSync(join(h.home,"bin/codex"),"fixture");chmodSync(join(h.home,"bin/codex"),0o755);h.setContext({branch:"main",displayName:"Main",terminals:[]});
 const b=createBootstrap({...h.deps,mode:"live",env:{...h.deps.env,PATH:join(h.home,"bin")},exec:async(bin,args)=>{
  // All terminal creation by this worker must use an explicit host focus ID.
  if(args[0]==="terminal"&&args[1]==="create"){h.calls.push(args);expect(args[args.indexOf("--worktree")+1]).toBe("id:focused");return '{"ok":true}';}
  return h.deps.exec(bin,args);
 }});
 await b.run(h.ctx,()=>{});expect(b.state.install.status).toBe("done");expect(b.state.start.status).toBe("done");expect(h.calls.some(a=>a[0]==="init"||a[1]==="install")).toBe(false);
 await b.refreshAgents(h.ctx,()=>{});expect(h.calls.find(a=>a[0]==="terminal")?.join(" ")).toContain("--worktree id:focused");
});
