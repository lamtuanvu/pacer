import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlugin, type PluginDeps } from "../orca-plugin/src/plugin";
import type { ApiClient } from "../src/api/client-types";
import { readSettings } from "../orca-plugin/src/settings";
import { notifyNewAlerts } from "../orca-plugin/src/notify";
import { emptySnapshot, type LinkSnapshot } from "../src/link/envelope";
import type { OrcaHost, OrcaWorkerContext } from "../orca-plugin/src/orca-api";
import { ManualTimers, flush } from "./plugin-transports.test";
import { renderPanel } from "../orca-plugin/src/panel";
import { LinkStore } from "../orca-plugin/src/store";
import { httpTransport } from "../orca-plugin/src/transports/http";
import { bridgeTransport } from "../orca-plugin/src/transports/bridge";
import { channelTransport } from "../orca-plugin/src/transports/channel";
import { contentKey, reduce, type Envelope } from "../src/link/envelope";
function fixture(heartbeat: number|null=100, marker=true, connect?: PluginDeps["connect"]) {
 const root=mkdtempSync(join(tmpdir(),"pacer-plugin-"));const timers=new ManualTimers();let now=100;
 let snapshot:LinkSnapshot={...emptySnapshot(),console:heartbeat===null?null:{handle:"term",paneKey:"pane",pid:1,startedAt:0,heartbeatAt:heartbeat}};
 const calls:{method:string;params:any}[]=[];const commands=new Map<string,(args?:unknown)=>unknown>();const events=new Map<string,(p:unknown)=>void|Promise<void>>();const writes:{path:string;text:string}[]=[];
 let ownerText:string|null=null;
 let accepted=true,throwSend=false,pending=false,context:any={branch:"pacer-task",displayName:"Project",terminals:[{id:"term"}]};
 const host={call:async(method:string,params:any)=>{calls.push({method,params});switch(method){case "settings.get":return {settings:{notifications:"all"}};case "events.subscribe":throw Error("invalid enum");case "storage.get":return {value:snapshot};case "workspace.readContext":return context;case "terminal.sendText":if(throwSend)throw Object.assign(Error("denied"),{code:"capability_denied"});return {accepted};case "notifications.show":return {delivered:true};case "settings.set":return {ok:true};default:throw Error(method);}}} as OrcaHost;
 const plugin=createPlugin({connect,home:root,pluginRoot:root,nowS:()=>now,timers,http:{get:async()=>pending?await new Promise(()=>{}):{status:401,body:""},stream:()=>()=>{}},fs:{readText:p=>p.endsWith(".pacer-panel-serve.json")?ownerText:"token",exists:p=>marker && p===join(root,".pacer-managed"),writeTextAtomic:(path,text)=>writes.push({path,text})}});
 const ctx:OrcaWorkerContext={host,commands:{register:(id,h)=>commands.set(id,h)},events:{on:(id,h)=>events.set(id,h)},grantedCapabilities:[],log:()=>{}};
 return {plugin,ctx,host,timers,calls,commands,events,writes,get snapshot(){return snapshot;},set snapshot(s){snapshot=s;},set ownerText(v:string|null){ownerText=v;},set accepted(v:boolean){accepted=v;},set throwSend(v:boolean){throwSend=v;},set pending(v:boolean){pending=v;},set context(v:any){context=v;},set now(v:number){now=v;},async start(){await plugin.activate(ctx);await flush();},async cleanup(){await plugin.deactivate();rmSync(root,{recursive:true,force:true});}};
}
const sends=(f:ReturnType<typeof fixture>)=>f.calls.filter(c=>c.method==="terminal.sendText");
const notes=(f:ReturnType<typeof fixture>)=>f.calls.filter(c=>c.method==="notifications.show");
test("settings validate defaults, forced transport and clamped poll range",()=> {expect(readSettings({},"/tmp/home")).toEqual({transport:"auto",port:4317,pacerHome:"/tmp/home/.pacer",pollSeconds:10,lastAlertAt:0,notifications:"important"});expect(readSettings({transport:"bridge",pollSeconds:1,port:-1,lastAlertAt:NaN},"/tmp")).toMatchObject({transport:"bridge",pollSeconds:5,port:4317,lastAlertAt:0});expect(readSettings({transport:"invalid",pollSeconds:999},"/tmp")).toMatchObject({transport:"auto",pollSeconds:300});});
test("activation registers all commands without awaiting transport probes",async()=> {const f=fixture();f.pending=true;try{await f.plugin.activate(f.ctx);expect([...f.commands.keys()].sort()).toEqual(["open"]);expect(f.events.has("plugin.message")).toBe(false);}finally{await f.cleanup();}});
test("alerts persist delivery ids and throttle batches",async()=>{const f=fixture();try{const settings=readSettings({notifications:"all"},"/tmp");const s=emptySnapshot();s.alerts=[{key:"a",level:"warn",title:"A",body:"",at:1001}];await notifyNewAlerts(f.host,s,settings,1000,1001);await notifyNewAlerts(f.host,s,settings,1000,1002);expect(notes(f)).toHaveLength(1);expect(settings.deliveredAlerts).toEqual([{key:"a",at:1001}]);expect(settings.lastAlertAt).toBe(1001);}finally{await f.cleanup();}});
for(const marker of [false,true])test(`panel writes require managed marker ${marker}`,async()=> {const f=fixture(100,marker);try{f.snapshot={...f.snapshot,alerts:[{key:"a",level:"warn",title:"New alert",body:"body",at:100}]};await f.start();await f.timers.advance(2000);expect(f.writes.length).toBe(marker?1:0);expect([...f.commands.keys()]).toEqual(["open"]);await f.timers.advance(2000);expect(f.writes.length).toBe(marker?1:0);expect(notes(f).filter(c=>c.params.title==="New alert")).toHaveLength(marker?1:0);if(marker)expect(f.writes[0].path.endsWith("/panel/live.html")).toBe(true);await f.plugin.deactivate();expect(f.timers.jobs.filter(j=>!j.cancelled)).toHaveLength(0);}finally{await f.cleanup();}});

test("activation remains under one second when settings host never responds",async()=> {
 const f=fixture();
 const original=f.ctx.host.call.bind(f.ctx.host);
 f.ctx.host={call:((method:any,params:any)=>method==="settings.get"?new Promise(()=>{}):original(method,params)) as OrcaHost["call"]};
 let activated=false;
 try {void f.plugin.activate(f.ctx).then(()=>activated=true);await flush();await f.timers.advance(500);expect(activated).toBe(true);expect(f.commands.size).toBe(1);}finally{await f.cleanup();}
});

test("status page escapes script injection in goals and alerts", () => {
 const attack = "</script><img src=x onerror=alert(1)>\u2028\u2029";
 const s: LinkSnapshot = {...emptySnapshot(),
  console:{handle:attack,paneKey:null,pid:1,startedAt:100,heartbeatAt:100},
  tasks:[{id:"t",state:"running",goal:attack,executor:attack,backend:null,worktree:attack,updatedAt:100}],
  alerts:[{key:"a",level:"error",title:attack,body:attack,at:100}],
 };
 const html = renderPanel(s,{nowS:100,transport:"bridge",reachable:true});
 expect(html).not.toContain("<img src=x");
 expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
 expect(html).toContain("Running");expect(html).toContain("Alerts");
 expect(html).not.toContain("<script");
});

test("store contract produces the same content through HTTP SSE, bridge and channel", async () => {
 const timers = new ManualTimers();
 const envelopes: Envelope[] = [
  {v:1,type:"budget",data:{generatedAt:100,strategy:"s",planner:"p",mode:"normal",providers:[],ranked:[]}},
  {v:1,type:"mode",data:{mode:"normal",previous:null,strategy:"s",at:100}},
  ...["running","done"].map(state => ({v:1 as const,type:"task" as const,data:{id:"t",state,goal:"goal",executor:"e",backend:null,worktree:null,updatedAt:100}})),
  {v:1,type:"alert",data:{key:"a",level:"warn",title:"Finished",body:"body",at:100}},
 ];
 let bridgeSnapshot = emptySnapshot();
 let onLine!: (line: string) => void;
 let onMessage!: (payload: unknown) => void;
 const host = {call:async (method:string) => {
  if (method === "storage.get") return {value:bridgeSnapshot};
  if (method === "events.subscribe") return {subscribed:["plugin.message"]};
  throw new Error(method);
 }} as OrcaHost;
 const transports = [
  httpTransport({timers,port:4317,readToken:()=>"test-token",http:{get:async()=>({status:200,headers:{"x-pacer":"1"},body:JSON.stringify(bridgeSnapshot)}),stream:(_url,_token,fn)=>{onLine=fn;return()=>{};}}}),
  bridgeTransport({host,timers,pollMs:5000}),
  channelTransport({host,registerEvent:(_name,fn)=>{onMessage=fn;}}),
 ];
 const stores = transports.map(()=>new LinkStore(()=>100));
 const stops: (()=>void)[] = [];
 try {
  for (const [i,t] of transports.entries()) {
   expect(await t.probe()).toBe(true);
   stops.push(t.watch(e=>stores[i].apply(e),s=>stores[i].replace(s)));
  }
  for (const e of envelopes) {
   bridgeSnapshot = reduce(bridgeSnapshot,e,100);
   onLine(`data: ${JSON.stringify(e)}`); onMessage({data:e});
   await timers.advance(5000);
   for (const store of stores) expect(JSON.parse(contentKey(store.snapshot))).toEqual(JSON.parse(contentKey(bridgeSnapshot)));
   expect(contentKey(stores[0].snapshot)).toBe(contentKey(stores[1].snapshot));
   expect(contentKey(stores[0].snapshot)).toBe(contentKey(stores[2].snapshot));
  }
  expect(stores[0].snapshot.tasks).toMatchObject([{id:"t",state:"done"}]);
  expect(stores[0].snapshot.alerts).toMatchObject([{key:"a",title:"Finished"}]);
 } finally { for (const stop of stops) stop(); }
});

test("activation tolerates hosts that throw for unknown event names", async () => {
 const f=fixture();
 f.ctx.events.on=(name,h)=>{if(name==="plugin.message")throw Error("unknown event");f.events.set(name,h);};
 try {await f.start(); expect(f.commands.size).toBe(1); expect(await f.commands.get("open")!()).toEqual({ok:true});} finally {await f.cleanup();}
});
test("equal timestamp alerts are queued before advancing the watermark",async()=>{
 const f=fixture(),settings=readSettings({notifications:"all"},"/tmp"),s=emptySnapshot();s.alerts=Array.from({length:7},(_,i)=>({key:`same-${i}`,level:"warn",title:`Same ${i}`,body:"",at:101}));
 try{for(let i=0;i<8;i++)await notifyNewAlerts(f.host,s,settings,100,101+i*5);expect(notes(f)).toHaveLength(7);expect(settings.deliveredAlerts).toHaveLength(7);}finally{await f.cleanup();}
});

test("HTTP heartbeat-only polls leave the panel file unchanged", async () => {
 const f=fixture();let now=100;const panels:string[]=[];
 const plugin=createPlugin({home:"/tmp/fake",pluginRoot:"/tmp/fake",nowS:()=>now,timers:f.timers,
  http:{get:async()=>({status:200,headers:{"x-pacer":"1"},body:JSON.stringify(f.snapshot)}),stream:()=>()=>{}},
  fs:{readText:()=>"token",exists:()=>true,writeTextAtomic:(_path,text)=>panels.push(text)}});
 try {
  await plugin.activate(f.ctx);await flush();await f.timers.advance(2000);
  expect(panels.at(-1)).toContain("Live · updated");
  now=120;await f.timers.advance(10000);
  expect(panels).toHaveLength(1);
  f.snapshot={...f.snapshot,console:{...f.snapshot.console!,heartbeatAt:120}};
  await f.timers.advance(10000);
  expect(panels).toHaveLength(1);
  f.snapshot={...f.snapshot,tasks:[{id:"t",state:"done",goal:"changed",executor:"codex",backend:null,worktree:null,updatedAt:140}]};
  await f.timers.advance(10000);expect(panels).toHaveLength(2);expect(panels.at(-1)).toContain("changed");
 }finally{await plugin.deactivate();await f.cleanup();}
});

test("equal budgets with alternating generation times do not rewrite or notify",async()=>{
 const f=fixture();
 try {
  f.snapshot={...f.snapshot,budget:{generatedAt:100,strategy:"s",planner:"p",mode:"normal",providers:[],ranked:[]}};
  await f.start();await f.timers.advance(2000);
  const before=f.writes.length;const notices=notes(f).length;
  for(const generatedAt of [200,100,200]){
   f.snapshot={...f.snapshot,budget:{...f.snapshot.budget!,generatedAt}};
   await f.timers.advance(10000);
  }
  expect(f.writes.length).toBe(before);expect(notes(f).length).toBe(notices);
 }finally{await f.cleanup();}
});

test("HTTP failures switch to bridge after three polls and recover when HTTP returns",async()=>{
 const f=fixture();let up=true,stops=0;
 const plugin=createPlugin({home:"/tmp",pluginRoot:"/tmp",nowS:()=>100+f.timers.now/1000,timers:f.timers,
  http:{get:async(url)=>up?{status:200,body:url.endsWith("/health")?'{"ok":true}':JSON.stringify(f.snapshot),headers:{"x-pacer":"1"}}:{status:503,body:""},stream:()=>()=>{stops++;}},
  fs:{readText:()=>"token",exists:()=>true,writeTextAtomic:(path,text)=>f.writes.push({path,text})}});
 try {
  await plugin.activate(f.ctx);await flush();await f.timers.advance(2000);
  expect(f.writes.at(-1)!.text).toContain("Live · updated");
  up=false;f.snapshot={...f.snapshot,console:{...f.snapshot.console!,handle:"bridge-console"}};f.context={branch:"x",displayName:"X",terminals:[{id:"bridge-console"}]};
  await f.timers.advance(10000);
  expect(sends(f)).toHaveLength(0);
  await f.timers.advance(22000);
  expect(stops).toBeGreaterThan(0);
  expect(f.writes.at(-1)!.text).toContain("Not connected · last data");
  up=true;await f.timers.advance(12000);
  expect(f.writes.at(-1)!.text).toContain("Live · updated");
 }finally{await plugin.deactivate();await f.cleanup();}
});

test("synchronous lifecycle subscription refusal cannot fail activation",async()=>{
 const f=fixture();const original=f.host.call.bind(f.host);
 f.host.call=((m:any,p:any)=>{if(m==="events.subscribe")throw Error("denied");return original(m,p);}) as OrcaHost["call"];
 try{await f.start();expect(f.commands.size).toBe(1);}finally{await f.cleanup();}
});
test("HTTP recovery before failover restores reachable panel state",async()=>{
 const f=fixture();let up=true;const panels:string[]=[];
 const plugin=createPlugin({home:"/tmp",pluginRoot:"/tmp",nowS:()=>100+f.timers.now/1000,timers:f.timers,
 http:{get:async()=>({status:up?200:503,headers:{"x-pacer":"1"},body:JSON.stringify(f.snapshot)}),stream:()=>()=>{}},
 fs:{readText:()=>"token",exists:()=>true,writeTextAtomic:(_p,s)=>panels.push(s)}});
 try{
  await plugin.activate(f.ctx);await flush();await f.timers.advance(2000);
  up=false;await f.timers.advance(10000);expect(panels.at(-1)).toContain("Not connected");
  up=true;await f.timers.advance(10000);expect(panels.at(-1)).toContain("Live · updated");
 }finally{await plugin.deactivate();await f.cleanup();}
});
test("HTTP SSE and poll generation timestamps do not trigger renders or notifications",async()=>{
 const f=fixture();
 const originalCall=f.ctx.host.call.bind(f.ctx.host);
 f.ctx.host={call:((method:any,params:any)=>method==="settings.get"?Promise.resolve({settings:{autoConsole:false,notifications:"all"}}):originalCall(method,params)) as OrcaHost["call"]};let line!:(s:string)=>void;const panels:string[]=[];
 f.snapshot={...emptySnapshot(),at:100,budget:{generatedAt:100,strategy:"s",planner:"p",mode:"normal",providers:[],ranked:[]},
 alerts:[{key:"a",level:"info",title:"once",body:"",at:100}]};
 const plugin=createPlugin({home:"/tmp",pluginRoot:"/tmp",nowS:()=>100+f.timers.now/1000,timers:f.timers,
 http:{get:async()=>({status:200,headers:{"x-pacer":"1"},body:JSON.stringify(f.snapshot)}),stream:(_u,_t,l)=>{line=l;return()=>{};}},
 fs:{readText:()=>"token",exists:()=>true,writeTextAtomic:(_p,s)=>panels.push(s)}});
 try{
  await plugin.activate(f.ctx);await flush();await f.timers.advance(2000);
  for(let i=0;i<3;i++){line("data: "+JSON.stringify({v:1,type:"budget",data:{...f.snapshot.budget,generatedAt:200+i}}));await f.timers.advance(10000);}
  expect(panels).toHaveLength(1);expect(notes(f)).toHaveLength(1);
 }finally{await plugin.deactivate();await f.cleanup();}
});


test("real loopback server shutdown switches HTTP to bridge and restart restores HTTP",async()=>{
 const f=fixture();const panels:string[]=[];let streamStops=0;
 const serve=(port:number)=>Bun.serve({hostname:"127.0.0.1",port,fetch(req){
  return Response.json(new URL(req.url).pathname==="/health"?{ok:true}:f.snapshot,{headers:{"X-Pacer":"1"}});
 }});
 let server=serve(0);const port=server.port!;
 const original=f.host.call.bind(f.host);
 f.host.call=(async(m:any,p:any)=>m==="settings.get"?{settings:{port}}:original(m,p)) as OrcaHost["call"];
 const plugin=createPlugin({home:"/tmp",pluginRoot:"/tmp",nowS:()=>100+f.timers.now/1000,timers:f.timers,
 http:{get:async(url,token)=>{const r=await fetch(url,{headers:token?{Authorization:"Bearer "+token}:{}});return {status:r.status,body:await r.text(),headers:{"x-pacer":r.headers.get("x-pacer")??undefined}};},stream:()=>()=>{streamStops++;}},
 fs:{readText:()=>"token",exists:()=>true,writeTextAtomic:(_p,s)=>panels.push(s)}});
 const waitForPanel=async(transport:string)=>{
  const deadline=Date.now()+2000;
  const ready=()=>!!panels.at(-1)?.includes(transport === "http" ? "Live · updated" : "Not connected · last data") && (transport !== "bridge" || streamStops>0);
  while(!ready() && Date.now()<deadline){
   await f.timers.advance(1000);await Bun.sleep(10);await flush();
  }
  expect(ready()).toBe(true);
 };
 const restart=async()=>{
  const deadline=Date.now()+2000;
  while(true){
   try{return serve(port);}catch(e){
    if((e as {code?:string}).code!=="EADDRINUSE" || Date.now()>=deadline)throw e;
    await Bun.sleep(10);
   }
  }
 };
 try{
  await plugin.activate(f.ctx);await waitForPanel("http");
  server.stop(true);await waitForPanel("bridge");
  server=await restart();await waitForPanel("http");
 }finally{server.stop(true);await plugin.deactivate();await f.cleanup();}
});

test("panel metadata-only refresh never rewrites even after five minutes",async()=>{
 const f=fixture();try{
 await f.start();await f.timers.advance(2000);expect(f.writes).toHaveLength(1);
 for(let i=1;i<5;i++){f.now=100+i*60;f.snapshot={...f.snapshot,console:{...f.snapshot.console!,heartbeatAt:100+i*60}};await f.timers.advance(60000);expect(f.writes).toHaveLength(1);}
 f.now=402;f.snapshot={...f.snapshot,console:{...f.snapshot.console!,heartbeatAt:402}};await f.timers.advance(62000);expect(f.writes).toHaveLength(1);
 }finally{await f.cleanup();}
});

test("multi-console heartbeat ordering does not rewrite the panel",async()=>{
 const f=fixture();try{
 const other={...f.snapshot.console!,handle:"other",heartbeatAt:99};f.snapshot={...f.snapshot,consoles:[f.snapshot.console!,other]};await f.start();await f.timers.advance(2000);
 f.snapshot={...f.snapshot,console:{...other,heartbeatAt:110},consoles:[{...other,heartbeatAt:110},f.snapshot.console!]};await f.timers.advance(12000);expect(f.writes).toHaveLength(1);
 }finally{await f.cleanup();}
});
test("background task renders coalesce at ten seconds, retry outcomes render within two seconds, ages do not rewrite",async()=>{
 const f=fixture();f.snapshot={...f.snapshot,tasks:[{id:"old",state:"running",goal:"task",executor:"codex",backend:"direct",worktree:null,updatedAt:100}]};
 try{await f.start();await f.timers.advance(1000);expect(f.writes).toHaveLength(1);
 f.now=101;f.snapshot={...f.snapshot,tasks:[{...f.snapshot.tasks[0]!,updatedAt:101}]};await f.timers.advance(1000);expect(f.writes).toHaveLength(1);
 f.snapshot={...f.snapshot,tasks:[{...f.snapshot.tasks[0]!,state:"failed"}]};await f.timers.advance(1000);expect(f.writes).toHaveLength(1);
 f.now=102;f.snapshot={...f.snapshot,tasks:[...f.snapshot.tasks,{id:"retry",retryOf:"old",state:"queued",goal:"task",executor:null,backend:null,worktree:null,updatedAt:102}]};await f.timers.advance(2000);expect(f.writes).toHaveLength(2);
 expect(f.writes.at(-1)!.text).toContain("Running");expect(f.writes.at(-1)!.text).toContain("queued");
 }finally{await f.cleanup();}
});

test("worker refreshes notification preference after 30 seconds without rewriting the status page",async()=>{
 const f=fixture();let level="off",reads=0;const original=f.ctx.host.call.bind(f.ctx.host);
 f.ctx.host={call:((method:any,params:any)=>method==="settings.get"?(reads++,Promise.resolve({settings:{notifications:level}})):original(method,params)) as OrcaHost["call"]};
 try{await f.start();await f.timers.advance(200);expect(f.writes).toHaveLength(1);
 level="all";f.now=130;await f.timers.advance(29799);expect(reads).toBe(1);
 await f.timers.advance(1);await f.timers.advance(200);expect(reads).toBe(2);expect(f.writes).toHaveLength(1);
 f.snapshot={...f.snapshot,alerts:[{key:"new",level:"warn",title:"New notification",body:"",at:131}]};f.now=131;
 await f.timers.advance(10000);expect(notes(f).some(n=>n.params.title==="New notification")).toBe(true);
 }finally{await f.cleanup();}
});

for (const heartbeat of [null, 100]) test(`API polls update the status page without console IPC (heartbeat ${heartbeat})`, async () => {
 let connections = 0, snapshots = 0;
 const client: ApiClient = {
  kind: "stdio",
  hello: async () => ({protocol:"2.0.0",pacer:"0",ops:[],events:[]}),
  snapshot: async () => { snapshots++; return {protocol:"2.0.0",seq:snapshots,snapshot:f.snapshot}; },
  call: async <T>() => null as T,
  subscribe: () => () => {},
  close: () => {},
 };
 const f = fixture(heartbeat, true, async () => { connections++; return client; });
 try {
  await f.start();await f.timers.advance(2000);
  expect(f.writes.at(-1)!.text).toContain("Live · updated");
  const before = snapshots;
  f.snapshot = {...f.snapshot,budget:{generatedAt:100,strategy:"fresh",planner:"codex",mode:"normal",
   providers:[{id:"codex",verdict:"OK",pacePct:null,usedPct:42,resetsAt:null,window:null,stale:false}],ranked:[]}};
  await f.timers.advance(12000);
  expect(snapshots).toBeGreaterThan(before);
  expect(connections).toBe(1);
  expect(sends(f)).toHaveLength(0);
  expect(f.calls.filter(c=>c.method==="workspace.readContext")).toHaveLength(0);
  await f.timers.advance(2000);
  expect(f.writes.at(-1)!.text).toContain("42% used");
 } finally { await f.cleanup(); }
});


test("open command shows where to act", async () => {
 for(const managed of [true,false]) {
 const f=fixture(100,managed);try {
  await f.start();expect(await f.commands.get("open")!()).toEqual({ok:true});
  expect(notes(f).at(-1)!.params).toEqual({title:"Open pacer",body:"Run `pacer open` in a terminal to open the pacer app."});
  expect(await f.commands.get("open")!()).toEqual({ok:true});
  expect(notes(f).filter(n=>n.params.title==="Open pacer")).toHaveLength(2);
  expect(sends(f)).toHaveLength(0);
  expect(f.calls.some(c=>c.method==="workspace.readContext")).toBe(false);
  // Subscribed only so Orca starts the worker; handling them must not touch terminals or the workspace.
  for(const event of ["agent.status.changed","worktree.created"]){expect(f.events.has(event)).toBe(true);await f.events.get(event)!({state:"done",paneKey:"p"});}
  expect(f.events.has("worktree.removed")).toBe(false);
  expect(sends(f)).toHaveLength(0);
  expect(f.calls.some(c=>c.method==="workspace.readContext")).toBe(false);
 }finally{await f.cleanup();}
 }
});

test("panel writes only on visible change", async () => {
 const f=fixture();try {
  await f.start();await f.timers.advance(1000);
  for(let i=0;i<10;i++) {
   f.snapshot={...f.snapshot};await f.timers.advance(15000);
   f.snapshot={...f.snapshot,strategies:[`hidden-${i}`]};
   await f.timers.advance(15000);
  }
  expect(f.writes).toHaveLength(1);
  f.snapshot={...f.snapshot,alerts:[{key:"visible",level:"warn",title:"Visible change",body:"Changed",at:100}]};
  await f.timers.advance(15000);expect(f.writes).toHaveLength(2);
  expect(f.writes[1].text).toContain("Visible change");
 }finally{await f.cleanup();}
});

test("worker leaves the panel to serve until its ownership marker expires", async () => {
 const f=fixture();
 try {
  f.ownerText=JSON.stringify({at:100});
  await f.start();await f.timers.advance(2000);
  expect(f.writes).toHaveLength(0);
  f.now=159;await f.timers.advance(15000);
  expect(f.writes).toHaveLength(0);
  f.now=160;await f.timers.advance(15000);
  expect(f.writes).toHaveLength(1);
 } finally {await f.cleanup();}
});

test("worker can restore its page after serve ownership expires", async () => {
 const f=fixture();
 try {
  await f.start();await f.timers.advance(2000);
  expect(f.writes).toHaveLength(1);
  f.ownerText=JSON.stringify({at:100});
  await f.timers.advance(30000);
  expect(f.writes).toHaveLength(1);
  f.now=160;await f.timers.advance(30000);
  expect(f.writes).toHaveLength(2);
 } finally {await f.cleanup();}
});
