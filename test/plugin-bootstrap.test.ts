import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createBootstrap, download, releaseBase, releaseURL, GITHUB_RELEASES, UNPUBLISHED, cleanEnv, type BootstrapDeps, type BootstrapState } from "../orca-plugin/src/bootstrap";
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
  if(args[0]==="status")return JSON.stringify({caller:{orcaSessionId:"session-one"}});
  if(args[0]==="terminal"&&args[1]==="create")return JSON.stringify({ok:true,result:{terminal:{handle:"dashboard"}}});
  if(args[0]==="--version")return version;
  if(args[0]==="init"){mkdirSync(join(home,".pacer"),{recursive:true});writeFileSync(join(home,".pacer/strategy.yaml"),"strategy");}
  if(args[0]==="service"&&args[1]==="status")return JSON.stringify({installed});
  if(args[0]==="service"&&args[1]==="install")installed=true;
  return "";
 };
 const d:BootstrapDeps={home,env,version:"0.1.16",platform:"darwin",arch:"arm64",now:()=>at,exec,
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
test("bootstrap installs verified file release atomically, initializes once, installs service and persists steps",async()=>{
 const home=tmpDir(),r=release(home),h=harness({home}, {releaseBase:r.base});h.setInstalled(false);
 await h.run();expect(h.b.state.install.status).toBe("done");expect(h.b.state.start.status).toBe("done");
 const binary=join(home,".local/bin/pacer");expect(readFileSync(binary)).toEqual(r.bytes);expect(statSync(binary).mode&0o777).toBe(0o755);expect(readdirSync(join(home,".local/bin"))).toEqual(["pacer"]);
 expect(h.calls.map(c=>c.args)).toEqual([["init"],["service","status","--json"],["service","install"]]);
 expect(h.storage.at(-1)?.start.status).toBe("done");
 for(const c of h.calls){expect(c.env.ORCA_AGENT_SESSION_ID).toBeUndefined();expect(c.env.ORCA_TERMINAL_HANDLE).toBeUndefined();expect(c.timeout).toBe(30000);}
 await h.run();expect(h.calls).toHaveLength(3);h.time(600);await h.run();expect(h.calls.filter(c=>c.args[0]==="init")).toHaveLength(1);
});
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
 expect(fail.b.state.nextAt).toBe(840);expect(fail.b.state.failures).toHaveLength(5);
});
test("service restarts only after 15 seconds, at most once per minute and five per hour",async()=>{
 const h=harness();h.put(".local/bin/pacer");h.setHealthy(false);
 for(let i=0;i<6;i++){h.time(h.b.state.nextAt ?? 0);await h.run();}
 const restarts=h.calls.filter(c=>c.args[1]==="restart");expect(restarts).toHaveLength(5);expect(restarts[0].at).toBe(15);expect(h.b.state.start.status).toBe("failed");
});
test("uninstalled service uses install, not restart; init errors never touch agent configs",async()=>{
 const h=harness();h.put(".local/bin/pacer");h.setHealthy(false);h.setInstalled(false);await h.run();expect(h.calls.some(c=>c.args[1]==="install")).toBe(true);expect(h.calls.some(c=>c.args[1]==="restart")).toBe(false);
 const f=harness({exec:async(_bin,args)=>{if(args[0]==="init")throw new Error("no executor");return "pacer 0.1.16";}});f.put(".local/bin/pacer");await f.run();expect(f.b.state.start.status).toBe("failed");expect(existsSync(join(f.home,".claude"))).toBe(false);
});
test("bootstrap is single flight and persisted failure timing survives activation",async()=>{
 let finish!:()=>void;const gate=new Promise<void>(r=>{finish=r;});let n=0;
 const h=harness({exec:async(_bin,args)=>{n++;await gate;return args[0]==="--version"?"pacer 0.1.16":JSON.stringify({installed:true});}});h.put(".local/bin/pacer");
 const a=h.run(),b=h.run();expect(a).toBe(b);await Promise.resolve();finish();await a;expect(n).toBe(3);
 h.setStored({install:{status:"failed",detail:UNPUBLISHED},start:{status:"pending"},agents:[],nextAt:600,failures:[0],restarts:[]});await h.b.activate(h.ctx);await h.run();expect(h.b.state.install.detail).toBe(UNPUBLISHED);expect(n).toBe(3);
});
test("terminal preparation stays behind visible consent state and throttles per worktree",async()=>{
 const h=harness();let t=0;const r=async()=>{t+=31;h.time(t);await h.b.refreshAgents(h.ctx,()=>{});};h.put(".local/bin/pacer");h.put("bin/codex");h.setContext({worktreeId:"one",branch:"main",terminals:[]});
 await r();expect(h.calls).toHaveLength(0);await h.run();await r();
 const probes=h.calls.length;await h.b.refreshAgents(h.ctx,()=>{});expect(h.calls).toHaveLength(probes);
 expect(h.b.state.opening).toBe(true);expect(h.calls.at(-1)?.args).toEqual(["terminal","create","--worktree","active","--title","pacer setup","--json"]);
 await r();expect(h.calls.filter(c=>c.args[1]==="create")).toHaveLength(1);
 h.setContext({worktreeId:"two",branch:"other",terminals:[]});await r();expect(h.calls.filter(c=>c.args[1]==="create")).toHaveLength(2);
 h.setContext({worktreeId:"two",branch:"other",terminals:[{id:"shell",writable:true}]});await r();expect(h.b.state.terminal).toBe("shell");
 mkdirSync(join(h.home,".pacer"),{recursive:true});writeFileSync(join(h.home,".pacer/install-manifest.json"),JSON.stringify({planners:{codex:{}}}));await r();expect(h.b.state.agents[0].installed).toBe(true);
 const n=h.calls.length;h.setContext({branch:"third",terminals:[]});await r();expect(h.calls).toHaveLength(n);
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
test("setup panel renders pending, failure, consent preview, connected and ready states safely",()=>{
 const state:BootstrapState={install:{status:"done"},start:{status:"done"},agents:[{id:"codex",name:"Codex",installed:false,files:["~/.codex/hooks.json"],undo:"pacer uninstall codex"}],terminal:"shell"};
 const render=()=>renderPanel(emptySnapshot(),{nowS:0,transport:null,reachable:false,bootstrap:state});
 let html=render();expect(html).toContain("Connect my agents");expect(html).toContain("~/.codex/hooks.json");expect(html).toContain('data-connect-agents>');
 state.terminal=undefined;expect(render()).toContain("Opening a terminal…");
 state.install={status:"failed",detail:UNPUBLISHED};html=render();expect(html).toContain("Try again");expect(html).toContain("curl -fsSL");
 state.install={status:"failed",detail:"<script>bad</script>"};expect(render()).not.toContain("<script>bad</script>");
 state.install={status:"done"};state.agents[0].installed=true;html=render();expect(html).not.toContain('data-connect-agents>');expect(html).not.toContain('<div class="headline">Connect pacer');
});

test("bootstrap settings override release env and unsupported platform fails without downloads",async()=>{
 const h=harness({platform:"win32",fetch:(async()=>{throw new Error("network must not run");}) as unknown as typeof fetch});await h.run();expect(h.b.state.install.detail).toContain("manual pacer install");
 const home=tmpDir(),r=release(home),f=harness({home,env:{HOME:home,PATH:join(home,"bin"),PACER_RELEASE_BASE:"https://unused.invalid"}},{releaseBase:r.base});await f.run();expect(f.b.state.install.status).toBe("done");
});
test("terminal creation errors clear opening, throttle retry, and never type without consent",async()=>{
 const h=harness();h.put(".local/bin/pacer");h.put("bin/codex");await h.run();
 const b=createBootstrap({...h.d,exec:async(bin,args,env,timeout)=>{if(args[1]==="create")throw new Error("orca unavailable");return h.d.exec!(bin,args,env,timeout);}});await b.run(h.ctx,()=>{});
 h.setContext({worktreeId:"no-shell",branch:"main",terminals:[]});await b.refreshAgents(h.ctx,()=>{});expect(b.state.opening).toBe(false);expect(b.state.terminalAttempts?.["no-shell"]).toBe(0);
 expect(h.calls.some(c=>c.args[1]==="send")).toBe(false);b.stop();const n=h.calls.length;await b.run(h.ctx,()=>{});await b.refreshAgents(h.ctx,()=>{});expect(h.calls).toHaveLength(n);
});
test("terminal discovery uses CLI writability when panel workspace returns only IDs",async()=>{
 const h=harness();h.put(".local/bin/pacer");h.put("bin/codex");
 const b=createBootstrap({...h.d,exec:async(bin,args,env,timeout)=>args[1]==="show"?JSON.stringify({ok:true,result:{terminal:{connected:true,writable:args[3]==="shell",title:"shell"}}}):h.d.exec!(bin,args,env,timeout)});
 await b.run(h.ctx,()=>{});h.setContext({branch:"main",terminals:[{id:"readonly",writable:false},{id:"shell"}]});await b.refreshAgents(h.ctx,()=>{});expect(b.state.terminal).toBe("shell");
 expect(h.calls.some(c=>c.args[1]==="create")).toBe(false);
});


test("marketplace bootstrap persists milestone notifications across retries and worker restarts",async()=>{
 const h=harness({mode:"bootstrap"} as Partial<BootstrapDeps>);h.put(".local/bin/pacer");
 await h.b.activate(h.ctx);await h.run();expect(h.notifications).toEqual(["Installing pacer…","pacer is running in the pacer terminal tab."]);
 h.time(600);await h.run();expect(h.notifications).toHaveLength(2);expect(h.calls.filter(c=>c.args[0]==="plugin")).toHaveLength(1);
 const restarted=createBootstrap(h.d);await restarted.activate(h.ctx);h.time(1200);await restarted.run(h.ctx,()=>{});expect(h.notifications).toHaveLength(2);expect(h.calls.filter(c=>c.args[0]==="plugin")).toHaveLength(1);
});
test("marketplace failure notification is friendly and deduplicated after restart",async()=>{
 const h=harness({mode:"bootstrap",fetch:(async()=>new Response("",{status:404})) as unknown as typeof fetch} as Partial<BootstrapDeps>);
 await h.b.activate(h.ctx);await h.run();expect(h.notifications).toEqual(["Installing pacer…",UNPUBLISHED]);
 h.time(600);await h.run();const restarted=createBootstrap(h.d);await restarted.activate(h.ctx);h.time(1200);await restarted.run(h.ctx,()=>{});expect(h.notifications).toHaveLength(2);
});
test("marketplace opens one dashboard per session and prepares its folder once per version",async()=>{
 const h=harness({mode:"bootstrap"});h.put(".local/bin/pacer");
 await h.b.activate(h.ctx);await h.run();await h.b.refreshAgents(h.ctx,()=>{});
 expect(h.b.state.handoffVersion).toBe(h.d.version);
 expect(h.calls.filter(c=>c.args[0]==="plugin")).toHaveLength(1);
 const prepared=h.calls.find(c=>c.args[0]==="plugin")!;
 expect(prepared.args).toEqual(["plugin","install"]);expect(prepared.bin).toBe(join(h.home,".local/bin/pacer"));
 expect(prepared.env.ORCA_AGENT_SESSION_ID).toBeUndefined();expect(prepared.env.ORCA_TERMINAL_HANDLE).toBeUndefined();
 expect(h.storage.at(-1)?.handoffVersion).toBe(h.d.version);
 const upgraded=createBootstrap({...h.d,version:"0.1.17"});await upgraded.activate(h.ctx);h.time(600);await upgraded.run(h.ctx,()=>{});
 expect(h.calls.filter(c=>c.args[0]==="plugin")).toHaveLength(2);expect(upgraded.state.handoffVersion).toBe("0.1.17");
 const opened=h.calls.filter(c=>c.args[0]==="terminal");expect(opened).toHaveLength(1);
 expect(opened[0].args).toEqual(["terminal","create","--worktree","active","--title","pacer","--command",`${join(h.home,".local/bin/pacer")} dashboard`,"--json"]);
 expect(opened[0].env.ORCA_AGENT_SESSION_ID).toBeUndefined();expect(opened[0].env.ORCA_TERMINAL_HANDLE).toBeUndefined();
});
test("marketplace handoff retries failures at most five per hour and persists success",async()=>{
 const h=harness({mode:"bootstrap"});h.put(".local/bin/pacer");let attempts=0,fail=true;
 const b=createBootstrap({...h.d,exec:async(bin,args,env,timeout)=>{
  if(args[0]==="plugin"){attempts++;if(fail)throw new Error("copy failed");return "";}
  return h.d.exec!(bin,args,env,timeout);
 }});
 await b.activate(h.ctx);
 for(const at of [0,60,120,180,240]){h.time(at);await b.run(h.ctx,()=>{});}
 expect(attempts).toBe(5);expect(b.state.handoffVersion).toBeUndefined();expect(b.state.nextAt).toBe(3600);
 expect(h.notifications).toEqual(["Installing pacer…","pacer is running in the pacer terminal tab."]);
 h.time(3599);await b.run(h.ctx,()=>{});expect(attempts).toBe(5);
 fail=false;h.time(3600);await b.run(h.ctx,()=>{});expect(attempts).toBe(6);expect(b.state.handoffVersion).toBe(h.d.version);
 const restarted=createBootstrap(h.d);await restarted.activate(h.ctx);h.time(4200);await restarted.run(h.ctx,()=>{});
 expect(h.calls.some(c=>c.args[0]==="plugin")).toBe(false);expect(h.notifications).toHaveLength(2);
});

test("marketplace install errors show a friendly line rather than subprocess diagnostics",async()=>{
 const h=harness({mode:"bootstrap",exec:async()=>{throw new Error("spawn /private/fixture/pacer EACCES\ninternal details");}});h.put(".local/bin/pacer");await h.b.activate(h.ctx);await h.run();
 expect(h.notifications).toEqual(["Installing pacer…","pacer couldn't install. Try again shortly."]);
});


test("dashboard stays closed in the same session and opens once in a new session",async()=>{
 const h=harness({mode:"bootstrap"});h.put(".local/bin/pacer");await h.b.activate(h.ctx);await h.run();
 const restarted=createBootstrap({...h.d,exec:async(bin,args,env,timeout)=>args[0]==="status"?JSON.stringify({caller:{orcaSessionId:"session-two"}}):h.d.exec!(bin,args,env,timeout)});
 await restarted.activate(h.ctx);h.time(600);await restarted.run(h.ctx,()=>{});h.time(1200);await restarted.run(h.ctx,()=>{});
 expect(h.calls.filter(c=>c.args[0]==="terminal")).toHaveLength(2);
 expect(restarted.state.dashboardSessions).toEqual(["session-one","session-two"]);
});
test("dashboard launch failure is reserved durably and never reported as running",async()=>{
 const h=harness({mode:"bootstrap"});h.put(".local/bin/pacer");let launches=0;
 const d={...h.d,exec:async(bin:string,args:string[],env:NodeJS.ProcessEnv,timeout:number)=>{if(args[0]==="terminal"){launches++;return JSON.stringify({ok:false,error:{message:"closed"}});}return h.d.exec!(bin,args,env,timeout);}};
 const b=createBootstrap(d);await b.activate(h.ctx);await b.run(h.ctx,()=>{});const restarted=createBootstrap(d);await restarted.activate(h.ctx);h.time(60);await restarted.run(h.ctx,()=>{});
 expect(launches).toBe(1);expect(h.notifications).not.toContain("pacer is running in the pacer terminal tab.");expect(restarted.state.start.status).toBe("failed");
});
