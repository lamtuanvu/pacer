import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createBootstrap, download, releaseBase, releaseURL, GITHUB_RELEASES, UNPUBLISHED, MANUAL_HINT, cleanEnv, type BootstrapDeps, type BootstrapState } from "../orca-plugin/src/bootstrap";
import type { OrcaWorkerContext } from "../orca-plugin/src/orca-api";
import { renderPanel } from "../orca-plugin/src/panel";
import { emptySnapshot } from "../src/link/envelope";
import { tmpDir } from "./helpers";
function harness(options: Partial<BootstrapDeps> = {}, settings: Record<string, unknown> = {}) {
 const home=options.home ?? tmpDir(); let at=0, installed=true, healthy=true, version="pacer 0.1.16", stored:unknown=null; const notifications:string[]=[]; const saved=new Map<string,unknown>();
 let context:any={worktreeId:"wt",branch:"main",terminals:[{id:"shell",writable:true}]};
 const calls:{bin:string;args:string[];env:NodeJS.ProcessEnv;timeout:number;at:number}[]=[], storage:BootstrapState[]=[];
 const env={HOME:home,PATH:join(home,"bin"),ORCA_AGENT_SESSION_ID:"agent",ORCA_TERMINAL_HANDLE:"terminal"};
 const ctx={host:{call:async(method:string,params:any)=>{
  if(method==="settings.get") return {settings};
  if(method==="notifications.show"){notifications.push(params.title);return {delivered:true};}
  if(method==="storage.get")return {value:params.key==="bootstrap"?stored:saved.get(params.key)};
  if(method==="storage.set"){saved.set(params.key,structuredClone(params.value));if(params.key==="bootstrap"){stored=structuredClone(params.value);storage.push(stored as BootstrapState);}return {ok:true};}
  if(method==="workspace.readContext")return context;
  throw new Error(method);
 }},log:()=>{},commands:{register(){}},events:{on(){}},grantedCapabilities:[]} as OrcaWorkerContext;
 const exec:BootstrapDeps["exec"]=async(bin,args,env,timeout)=>{
  calls.push({bin,args,env,timeout,at});
  if(args[0]==="status")return JSON.stringify({ok:true,result:{app:{running:true,pid:111},runtime:{runtimeId:"r"}}});
  if(args[0]==="terminal"&&args[1]==="create")return JSON.stringify({ok:true,result:{terminal:{handle:"dashboard"}}});
  if(args[0]==="--version")return version;
  if(args[0]==="init"){mkdirSync(join(home,".pacer"),{recursive:true});writeFileSync(join(home,".pacer/strategy.yaml"),"strategy");}
  if(args[0]==="service"&&args[1]==="status")return JSON.stringify({installed});
  if(args[0]==="service"&&args[1]==="install")installed=true;
  return "";
 };
 const d:BootstrapDeps={home,env,version:"0.1.16",mode:"bootstrap",platform:"darwin",arch:"arm64",now:()=>at,exec,
  fetch:(async()=>new Response("{}",{status:healthy?200:503,headers:{"x-pacer":"1"}})) as unknown as typeof fetch,sleep:async ms=>{at+=ms/1000;},...options};
 const b=createBootstrap(d);
 const put=(path:string,text="fake")=>{mkdirSync(join(home,path,".."),{recursive:true});writeFileSync(join(home,path),text);chmodSync(join(home,path),0o755);};
 return {home,b,ctx,calls,storage,notifications,d,put,run:()=>b.run(ctx,()=>{}),time:(n:number)=>{at=n;},setVersion:(v:string)=>{version=v;},setInstalled:(v:boolean)=>{installed=v;},setHealthy:(v:boolean)=>{healthy=v;},setContext:(v:any)=>{context=v;},setStored:(v:unknown)=>{stored=v;}};
}
function release(home:string, checksum?:string) {
 const root=join(home,"release"),dir=join(root,"0.1.16"),name="pacer-darwin-arm64",bytes=Buffer.from("verified fixture");
 mkdirSync(dir,{recursive:true});writeFileSync(join(root,"latest.json"),JSON.stringify({version:"0.1.16"}));writeFileSync(join(dir,name),bytes);
 writeFileSync(join(dir,"SHA256SUMS"),`${checksum??createHash("sha256").update(bytes).digest("hex")}  ${name}\n`);
 return {base:pathToFileURL(root).href,dir,bytes};
}
for(const bad of ["0".repeat(64),"missing"] as const)test(`bootstrap refuses ${bad==="missing"?"missing":"mismatched"} checksum without writing binary`,async()=>{
 const home=tmpDir(),r=release(home,bad),h=harness({home},{releaseBase:r.base});await h.run();
 expect(h.b.state.install.status).toBe("failed");expect(existsSync(join(home,".local/bin/pacer"))).toBe(false);expect(h.calls).toHaveLength(0);
});
for(const version of ["pacer 0.1.15","pacer 0.1.16","pacer 0.2.0","development build","pacer 0.0.0-dev"])test(`bootstrap version policy ${version}`,async()=>{
 const h=harness({}, {releaseBase:"file:///release"});h.put(".local/bin/pacer");h.setVersion(version);await h.run();
 const update=h.calls.find(c=>c.args[0]==="update");expect(!!update).toBe(version==="pacer 0.1.15");
 if(update){expect(update.args).toEqual(["update","--to","0.1.16"]);expect(update.timeout).toBe(120000);expect(update.env.PACER_RELEASE_BASE).toBe("file:///release");}
});
test("binary precedence uses PACER_BIN, local binary, then PATH; default updates use GitHub",async()=>{
 for(const location of ["override",".local/bin/pacer","bin/pacer"]){const h=harness();h.put(location);h.put("bin/claude");h.put("bin/codex");h.setVersion("pacer 0.1.15");
  if(location==="override")h.d.env.PACER_BIN=join(h.home,location); // createBootstrap copies env; create a fresh instance
  const b=createBootstrap(h.d);await b.run(h.ctx,()=>{});expect(h.calls[0].bin).toBe(join(h.home,location));expect(h.calls.find(c=>c.args[0]==="update")?.env.PACER_RELEASE_BASE).toBeUndefined();
 }
});
test("bootstrap failures have 60 second bounded retries; 404 retries after ten minutes",async()=>{
 const h=harness({fetch:(async()=>new Response("",{status:404})) as unknown as typeof fetch});await h.run();expect(h.b.state.install.detail).toBe(UNPUBLISHED);expect(h.b.state.nextAt).toBe(600);const n=h.storage.length;h.time(599);await h.run();expect(h.storage).toHaveLength(n);
 const fail=harness({exec:async()=>{throw new Error("update failed");}});fail.put(".local/bin/pacer");
 for(const at of [0,60,120,180,240]){fail.time(at);await fail.run();}
 expect(fail.b.state.nextAt).toBe(3600);expect(fail.b.state.failures).toHaveLength(5);
});
test("release roots and URLs validate transport, credentials, query and GitHub layout",()=>{
 expect(releaseBase("file:///release/",{PACER_RELEASE_BASE:"bad"})).toBe("file:///release");expect(releaseBase(undefined,{PACER_RELEASE_BASE:"http://localhost:123/r"})).toBe("http://localhost:123/r");expect(releaseBase(undefined,{})).toBe(GITHUB_RELEASES);
 for(const bad of ["http://example.com/r","https://user:pw@example.com","https://host/r?q=x","https://host/r#x","file://otherhost/r"]){expect(()=>releaseBase(bad,{})).toThrow();}
 expect(releaseURL(GITHUB_RELEASES,"0.1.16","latest.json")).toEndWith("/latest/download/latest.json");expect(releaseURL(GITHUB_RELEASES,"0.1.16","SHA256SUMS")).toEndWith("/download/v0.1.16/SHA256SUMS");
 expect(cleanEnv({ORCA_AGENT_SESSION_ID:"a",ORCA_TERMINAL_HANDLE:"t",PATH:"p"})).toEqual({PATH:"p"});
});
test("downloads permit five HTTPS redirects, reject downgrade, missing location and sixth hop",async()=>{
 let n=0;const fetcher=(async()=>++n<=5?new Response(null,{status:302,headers:{location:"https://host/next"}}):new Response("bytes")) as unknown as typeof fetch;
 expect((await download("https://host/start",fetcher)).toString()).toBe("bytes");expect(n).toBe(6);
 for(const location of ["http://127.0.0.1/next","file:///next","https://user:pw@host/next",""]){await expect(download("https://host/start",(async()=>new Response(null,{status:302,headers:{location}})) as unknown as typeof fetch)).rejects.toThrow();}
 await expect(download("https://host/start",(async()=>new Response(null,{status:302,headers:{location:"https://host/next"}})) as unknown as typeof fetch)).rejects.toThrow("limit");
});
test("setup panel renders real readiness and escaped failures",()=>{
 const state:BootstrapState={install:{status:"done"},start:{status:"done"},agents:[{id:"codex",name:"Codex",installed:false,files:["~/.codex/hooks.json"],undo:"pacer uninstall codex"}]};
 const html=renderPanel(emptySnapshot(),{nowS:0,transport:null,reachable:false,bootstrap:state});
 expect(html).toContain("Codex");expect(html).toContain("Optional</h2>");expect(html).toContain("Not connected");expect(html).toContain("pacer init");expect(html).toContain("Re-checks every 5 seconds");
});

test("bootstrap settings override release env and unsupported platform fails without downloads",async()=>{
 const h=harness({platform:"win32",fetch:(async()=>{throw new Error("network must not run");}) as unknown as typeof fetch});await h.run();expect(h.b.state.install.detail).toContain("manual pacer install");
 const home=tmpDir(),r=release(home),f=harness({home,env:{HOME:home,PATH:join(home,"bin"),PACER_RELEASE_BASE:"https://unused.invalid"}},{releaseBase:r.base});await f.run();expect(f.b.state.install.status).toBe("done");
});
test("verified binary install is atomic and worker only opens init",async()=>{
 const home=tmpDir(),r=release(home),h=harness({home},{releaseBase:r.base});h.setInstalled(false);
 await h.run();const binary=join(home,".local/bin/pacer");expect(readFileSync(binary)).toEqual(r.bytes);expect(statSync(binary).mode&0o777).toBe(0o755);expect(readdirSync(join(home,".local/bin"))).toEqual(["pacer"]);
 expect(h.calls.some(c=>c.args[0]==="init"||c.args[1]==="install")).toBe(false);expect(h.calls.find(c=>c.args[1]==="create")?.args.join(" ")).toContain(`${binary} init`);expect(h.b.state.start.status).toBe("done");
});

test("live checklist probes binary version, active planner, running service and link without installing",async()=>{
 const h=harness({mode:"live",exec:async(_bin,args)=>args[0]==="--version"?"pacer 0.1.22":JSON.stringify({installed:true,running:false})});
 h.put(".local/bin/pacer");h.put(".pacer/strategy.yaml","planner: codex\n");h.put("bin/codex");
 let state=await h.b.checkSetup(true);expect(state.complete).toBe(false);expect(state.items.find(i=>i.id==="service")?.status).toBe("pending");expect(state.items.find(i=>i.id==="binary")?.detail).toBe("0.1.22");expect(state.items.find(i=>i.id==="strategy")?.detail).toBe("Planner: codex");
 h.put(".pacer/active","economy\n");h.put(".pacer/strategies/economy.yaml","planner: 'claude-code' # selected\n");state=await h.b.checkSetup(false);
 expect(state.items.find(i=>i.id==="strategy")?.detail).toBe("Planner: claude-code");expect(state.items.find(i=>i.id==="link")?.status).toBe("pending");expect(state.items.find(i=>i.id==="agent:codex")?.status).toBe("pending");
 const failed=createBootstrap({...h.d,mode:"live",exec:async()=>{throw Error("unavailable");}});state=await failed.checkSetup(false);expect(state.items.find(i=>i.id==="binary")?.status).toBe("failed");expect(state.items.find(i=>i.id==="service")?.status).toBe("failed");
});
